# Рунбук PortCity backend

Як запустити, наповнити, демонструвати й обслуговувати бекенд. Архітектура - `docs/ARCHITECTURE.md`,
ендпоїнти - `docs/API.md` і Swagger `/docs`, змінні середовища - `.env.example`. Приклади команд - для bash.

## 1. Складові

| Складова      | Що це                                                            | Залежності                                 |
| ------------- | ---------------------------------------------------------------- | ------------------------------------------ |
| API           | `node dist/main.js`, порт `PORT` (3000)                          | PostgreSQL; Redis при `QUEUE_DRIVER=redis` |
| Воркер        | `node dist/worker.js`, `/health` на `WORKER_PORT` (3001)         | PostgreSQL, Redis (обов'язково)            |
| PostgreSQL 17 | дані всіх модулів, outbox, аудит                                 | -                                          |
| Redis 7       | черги BullMQ, квота неверифікованих номерів паркінгу             | `maxmemory-policy noeviction`              |
| S3 / MinIO    | фото чеків і звернень (приватні), зображення (публічні префікси) | у розробці можна `memory`                  |

Без воркера не працюють: доставка подій outbox (сповіщення, бонуси, позначка оплати паркінгу після
`payment.succeeded`), розклади (згоряння балів, звіти, синхронізація паркінгу, видалення акаунтів).

## 2. Запуск з Docker Compose (локальне демо)

```bash
docker compose up --build                 # PostgreSQL, Redis, API :3000, воркер :3001
docker compose --profile tools up -d      # + Adminer :8080, Metabase :3030, MinIO :9000/:9001
```

- Контейнер API перед стартом виконує `prisma migrate deploy` (`RUN_MIGRATIONS=true`), воркер - ні.
- Стек працює з `NODE_ENV=development`: емулятор паркінгу (`PARKING_EMULATOR_ANCHOR=now`), мок-платежі,
  SMS у лог, демо-номер `+380501234567` з фіксованим кодом `123456` (`OTP_STATIC_CODES`). У production ці
  адаптери і dev-секрети відхиляються при старті.
- Сховище типово `memory`. Для MinIO: `docker compose --profile tools up -d minio`, створіть бакет
  `portcity` у консолі http://localhost:9001 і запустіть стек з `STORAGE_DRIVER=s3`.
- Seed виконується з хоста (у runtime-образі немає `ts-node`):

```bash
npm ci && npm run db:generate
DATABASE_URL=postgresql://portcity:portcity@localhost:5432/portcity?schema=public npm run db:seed
```

- Логи: `docker compose logs -f api worker`; перевірка: `curl localhost:3000/health`, `curl localhost:3000/ready`.

## 3. Запуск без Docker

1. Node 24 (`.nvmrc`), PostgreSQL 17 і Redis 7 (локально або керовані сервіси). База має бути в UTF-8 з
   локаллю, що знає регістр кирилиці: `en_US.UTF-8`, `uk_UA.UTF-8` або вбудована в PostgreSQL 17
   `C.UTF-8` (`initdb --locale-provider=builtin --builtin-locale=C.UTF-8`). З локаллю `C` пошук
   «олег» не знаходить «Олег»; API пише про це помилку в лог під час старту.
2. `cp .env.example .env`, вкажіть `DATABASE_URL`, `REDIS_URL`; для демо входу - `OTP_DEV_ECHO=true` або
   `OTP_STATIC_CODES=+380501234567:123456`.
3. `npm ci`, потім `npm run db:generate` (npm 11 без дозволу `allowScripts` не запускає postinstall
   `@prisma/client`, тож клієнт треба згенерувати явно), `npm run db:deploy`, `npm run db:seed`.
4. `npm run start:dev` (API) і в іншому терміналі `npm run start:worker:dev` (воркер).
5. Продакшн-збірка: `npm run build`, потім `npm start` і `npm run start:worker`.

Без БД і Redis API стартує з `PRISMA_LAZY_CONNECT=true QUEUE_DRIVER=memory` (маршрути, Swagger, `/health`),
але бізнес-ендпоїнти потребують PostgreSQL. Так працюють e2e-тести і `npm run openapi`.

## 4. Міграції

| Дія                           | Команда                                                                                                                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Застосувати всі міграції      | `npm run db:deploy` (`prisma migrate deploy`)                                                                                                                                                                      |
| Статус                        | `npx prisma migrate status`                                                                                                                                                                                        |
| Нова міграція з БД розробника | змінити `prisma/schema/*.prisma`, `npm run db:migrate -- --name <назва>`                                                                                                                                           |
| Нова міграція без БД          | скопіювати `prisma/schema` до змін, потім `npx prisma migrate diff --from-schema-datamodel <копія> --to-schema-datamodel prisma/schema --script > prisma/schema/migrations/<YYYYMMDDHHMMSS>_<назва>/migration.sql` |
| Перевірити схему              | `DATABASE_URL=postgresql://x:x@localhost:5432/x npx prisma validate`                                                                                                                                               |
| Повний скид локальної БД      | `npm run db:reset` (видаляє дані)                                                                                                                                                                                  |

Правила: застосовані міграції не редагуються (виправлення - новою міграцією); ручний SQL, якого Prisma не
бачить (тригери append-only, часткові індекси, CHECK, EXCLUDE, FK без відношень, послідовності, заповнення
даних), дописується у файл міграції з коментарем (послідовність - до таблиці, що її використовує; CHECK,
тригери, індекси й заповнення - після DDL); перед міграцією з `NOT NULL` на наявних даних - крок
заповнення; жоден об'єкт не створюється двічі в різних міграціях. Наявні: `20261030120000_init`,
`20261101120000_module_requests` і `20261101180000_review_fixes` (опис - `docs/INTEGRATION_NOTES.md`;
початкові SQL-файли модулів - архів `docs/pending-sql/applied/`). Відкат - лише вперед: нова міграція або
відновлення з резервної копії. Перед деплоєм міграції 3 на базу з реальними даними - резервна копія.

Об'єкти, яких немає в схемі Prisma (FK `support_requests` і `events.tenant_id`, таблиці звітів
`receipt_canonical_collisions` і `fiscal_number_canonical_collisions`, часткові індекси), `prisma migrate dev`
на базі розробника може побачити як розбіжність і запропонувати видалити: таку пропозицію з нової міграції
треба прибрати вручну (або генерувати міграції через `migrate diff` між копіями схеми, як вище).

### 4.1 Після міграції `20261101180000_review_fixes`: звіт канонічних номерів чеків

Міграція звела номери кас (`fn`) і чеків (`fiscal_id`) до канонічного вигляду (як застосунок: без
роздільників і провідних нулів, верхній регістр). Для кожного канонічного `(fn, fiscal_id)` лишився
найстаріший чек; пізніші копії отримали службовий номер `#<id>` і записані в звіт. Одразу після деплою:

```sql
-- 1. Зараховані дублікати: бали треба сторнувати (не SQL-ом по points_transactions!)
SELECT receipt_id, user_id, kept_receipt_id, points_awarded, points_tx_id
FROM receipt_canonical_collisions WHERE action = 'credited_needs_reversal' ORDER BY detected_at;
-- 2. Учасники з кількома колізіями (ймовірне зловживання)
SELECT user_id, count(*) FROM receipt_canonical_collisions GROUP BY user_id HAVING count(*) > 1;
-- 3. Об'єднані номери кас білого списку (зайві заблоковано з приміткою "duplicate of ...")
SELECT * FROM fiscal_number_canonical_collisions ORDER BY detected_at;
-- 4. Чеки, номери яких не вдалося канонізувати (крапки, кирилиця) - лишилися як були
SELECT id, fn, fiscal_id FROM receipts WHERE fiscal_id NOT LIKE '#%' AND fiscal_id !~ '^[A-Z0-9]{1,64}$';
```

- `action = rejected`: відкриті копії стали `rejected` з `PC_RECEIPT_DUPLICATE` (учасник бачить причину
  «Цей чек уже зареєстровано в програмі», може оскаржити). Дій не потрібно.
- `action = credited_needs_reversal`: бали за копію треба повернути через леджер - ручне коригування
  `POST /admin/adjustments` з від'ємною сумою `points_awarded` і причиною «Повторне зарахування того самого
  чека (<receipt_id>)» (понад 500 балів - друге затвердження), або разовий скрипт через
  `CLUB_LEDGER_PORT.reverse` з ключем `receipt-duplicate:<receipt_id>`. Ніколи не змінювати
  `points_transactions` напряму: таблиця append-only, а кешовані баланси розійдуться.
- Номери кас із запиту 3: перевірити, що збережений `active`-номер належить правильному орендарю.
- Після опрацювання таблиці звітів можна видалити окремою міграцією (`DROP TABLE receipt_canonical_collisions,
fiscal_number_canonical_collisions;`). На чистій базі (seed) звіти порожні: номери seed уже канонічні.

Також міграція позначає вже заповнені поля профілю наявних учасників як оголошені (бонуси за поля -
лише за нові заповнення), нормалізує IPv4-mapped адреси OTP, заповнює `vouchers.image_key` з винагород,
`parking_payment_links` (`paid_until`, `outcome = applied` для вже оплачених) і
`manual_adjustments.second_approval_reason = 'amount'` для коригувань понад поріг.

## 5. Seed

`npm run db:seed` ідемпотентний (upsert за природними ключами або стабільними id), його можна запускати
повторно (CI запускає двічі). Створює:

- адміністратора `admin@portcity.local` (роль owner) з паролем `SEED_ADMIN_PASSWORD` (у development типово
  `ChangeMe-2026!`, seed друкує попередження); хеш - параметри бек-офісу (scrypt ln=17, ключ 64 байти);
- 14 орендарів з годинами роботи, розташуванням і картою поверху, по 2 фіскальні номери на учасника
  програми, ТамТам виключений із програми; рядок `mall_info` (Telegram, інфостійка, оператор паркінгу,
  правила, юридичні документи, карти поверхів і паркінгу; адреса й контакти підтримки - з конфігурації);
- винагороди, акції з категоріями, дві події (майстер-клас Figli Migli 4-10 років до 4 осіб з реєстрацією
  і кінопоказ Premier City із зовнішнім входом), набір правил v1 (вітальні бонуси 50 / 0 / 20: бонус за
  профіль тепер платиться за поля - 10 за поле і 20 за повний профіль, `PROFILE_BONUS_*`), тариф v1,
  прапорці `parking.info_mode`, `receipts.manual_submission`, `events.registration`
  (`maxPersonsPerRegistration: 4`, увімкнені) і `parking.air_raid` (вимкнений);
- демо-учасника `+380501234567` (код картки `734211800`, стать, місто, дитина; усі поля профілю позначені
  як уже оголошені), авто `AC1234BC` «Моє авто» (верифіковане), 320 доступних балів, 6 транзакцій з
  назвами для історії (списання з розподілом за кошиками), 3 чеки (зараховано, на модерації, відхилено),
  погашений ваучер, 2 сповіщення;
- валідатор «Aroma Kava, каса 1»: ключ `SEED_VALIDATOR_KEY` (у development типово `dev-validator-aroma-kava`),
  PIN `SEED_VALIDATOR_PIN` (6-12 цифр, у development типово `246813`);
- демо-сесію паркінгу на сьогодні за `PARKING_EMULATOR_SCENARIO` (рівень -2, ряд C); у сценаріях
  `paid`/`closed` - оплачений платіж, уже застосований і зареєстрований в операторі;
- у development - нумерацію звернень з № 1042 (як у прототипі), якщо звернень ще немає.

Облікові дані записуються лише при створенні рядка: повторний seed **не змінює** пароль, роль, активність і
TOTP адміністратора, PIN, ключ і активність валідатора (змінюйте їх через бек-офіс). Бази, засіяні раніше,
зберігають старий PIN `1234` (він і далі відкриває зміну, але новий PIN має бути 6-12 цифр).

З `NODE_ENV=production` seed відмовляється працювати, якщо не задано `SEED_ADMIN_PASSWORD` (від 12
символів), `SEED_VALIDATOR_KEY` (від 32 випадкових символів), `SEED_VALIDATOR_PIN` або якщо це значення за
замовчуванням з репозиторію; `SEED_ADMIN_TOTP_SECRET` у production теж відхиляється. Seed запускається з
робочої копії репозиторію (у runtime-образі немає `ts-node` і `src/`) і створює також демо-учасника й
демо-дані - на production-базі їх треба видалити або не запускати seed (відкрите питання).

### 5.1 TOTP адміністратора (перший вхід, скидання)

Ролі з `ADMIN_REQUIRE_TOTP_ROLES` (типово `owner,manager`) не входять самим паролем. Перший вхід owner:

```bash
# 1. Пароль -> 403 PC_ADMIN_TOTP_SETUP_REQUIRED з details.enrollmentToken (5 хв)
curl -s -X POST $API/admin/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"admin@portcity.local","password":"<пароль>"}'
# 2. Новий секрет: secret (base32), otpauthUri (для QR) і setupToken (10 хв)
curl -s -X POST $API/admin/auth/totp/enroll -H 'Content-Type: application/json' \
  -d '{"enrollmentToken":"<details.enrollmentToken>"}'
# 3. Додати секрет у застосунок-автентифікатор (Google Authenticator, 1Password...), ввести перший код:
#    відповідь - admin accessToken, TOTP увімкнено
curl -s -X POST $API/admin/auth/totp/enroll/confirm -H 'Content-Type: application/json' \
  -d '{"setupToken":"<setupToken>","code":"123456"}'
```

Далі вхід - у два кроки: пароль -> `401 PC_ADMIN_TOTP_REQUIRED` з `details.challengeToken` ->
`POST /admin/auth/totp {"challengeToken":"...","code":"..."}` (до 5 кодів на виклик, кожен код - один раз).
Для локального демо без телефона: `SEED_ADMIN_TOTP_SECRET=<base32>` перед першим seed (лише development; секрет
вводиться в автентифікатор вручну) або `ADMIN_REQUIRE_TOTP_ROLES=none` у локальному `.env` (не в production).

Скидання TOTP (адміністратор втратив телефон; ендпоїнта немає - відкрите питання identity): інший owner
або DBA після перевірки особи виконує в одній транзакції

```sql
BEGIN;
UPDATE admin_users SET totp_secret = NULL, totp_last_step = NULL, login_challenge_id = NULL,
       login_challenge_attempts = 0, updated_at = now()
 WHERE email = '<e-mail>';
INSERT INTO audit_logs (id, actor_type, actor_id, action, entity_type, entity_id, reason, created_at)
SELECT gen_random_uuid(), 'admin', '<id того, хто скидає>', 'admin_user.totp_reset', 'admin_user', id::text,
       '<номер заявки>', now() FROM admin_users WHERE email = '<e-mail>';
COMMIT;
```

Наступний вхід цього адміністратора знову пройде налаштування TOTP (кроки 1-3). Кеш `AdminGuard` (30 с)
на скидання не впливає.

## 6. Демо-сценарій паркінгу з емулятором

Канон дизайну: в'їзд 14:00, безкоштовно до 14:30, о 15:20 до сплати 60 грн, оплата - виїзд до 16:00,
виїзд о 15:52 («1 год 52 хв · 60 грн»).

| `PARKING_EMULATOR_SCENARIO` | Що бачить застосунок (герой)                              |
| --------------------------- | --------------------------------------------------------- |
| `free`                      | F2: безкоштовно до 14:30                                  |
| `payable` (типово)          | F3: до сплати 60 грн, «наступна година почнеться о 16:00» |
| `paid`                      | F4: оплачено до 16:00; після 16:00 - прострочення (F5)    |
| `closed`                    | F6: виїзд о 15:52                                         |

`PARKING_EMULATOR_ANCHOR=today` прив'язує часову лінію до сьогоднішнього дня за Києвом (як seed); `now` зсуває її
так, щоб "зараз" було моментом сценарію (`payable` - 15:20) - зручно для демо в будь-який час.

Крок за кроком (API на :3000, воркер запущено):

```bash
API=http://localhost:3000/api/v1
# 1. Вхід демо-учасника (код 123456 з OTP_STATIC_CODES або debugCode з OTP_DEV_ECHO=true)
curl -s -X POST $API/auth/otp/request -H 'Content-Type: application/json' -d '{"phone":"+380501234567"}'
TOKEN=$(curl -s -X POST $API/auth/otp/verify -H 'Content-Type: application/json' \
  -d '{"phone":"+380501234567","code":"123456","device":{"platform":"ios","model":"demo","fingerprint":"demo-1"}}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).accessToken')
# 2. Герой паркінгу: стан F3, сума 60 грн, id сесії
curl -s $API/parking/session -H "Authorization: Bearer $TOKEN"
# 3. Оплата (Idempotency-Key обов'язковий): відповідь містить checkoutUrl мок-провайдера
curl -s -X POST $API/parking/session/<sessionId>/pay -H "Authorization: Bearer $TOKEN" \
  -H 'Idempotency-Key: demo-pay-0001'
# 4. Завершити мок-оплату (або відкрити checkoutUrl у браузері і натиснути «Оплатити»)
curl -s -X POST $API/mock-checkout/<providerRef>/complete -H 'Content-Type: application/json' \
  -d '{"outcome":"succeeded"}'
# 5. Воркер обробляє payment.succeeded: сесія paid до 16:00, сповіщення parking_paid «Паркінг оплачено»
#    (квитанція: GET $API/payments/<paymentId> - номер, отримувач-оператор, «виїзд до», QR для оператора)
curl -s $API/parking/session -H "Authorization: Bearer $TOKEN"
curl -s $API/notifications -H "Authorization: Bearer $TOKEN"
```

Подія оператора вручну (вебхук емулятора, підпис - HMAC-SHA256 від точних байтів тіла):

```bash
PARKING_WEBHOOK_SECRET=${PARKING_WEBHOOK_SECRET:-dev-only-parking-webhook-secret}
# 12:00Z = 14:00 за Києвом (UTC+2 у листопаді), 13:52Z = 15:52
BODY='{"eventId":"demo-exit-1","type":"session.closed","session":{"providerRef":"emu-demo-session","plate":"AC1234BC","enteredAt":"2026-11-01T12:00:00.000Z","exitedAt":"2026-11-01T13:52:00.000Z","closedReason":"exit"}}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$PARKING_WEBHOOK_SECRET" | sed 's/^.* //')
curl -s -X POST $API/webhooks/parking/emulator -H 'Content-Type: application/json' \
  -H "X-Parking-Signature: sha256=$SIG" --data-binary "$BODY"
```

Повітряна тривога (вільний виїзд у перші 30 хв): адміністратор вмикає прапорець
`PUT $API/admin/feature-flags/parking.air_raid` з тілом `{"enabled":true,"payload":{"startedAt":"<ISO>"},"reason":"тривога"}`
і вимикає `{"enabled":false}` після відбою (кеш прапорців - до 5 с).

Інші сценарії: `PARKING_EMULATOR_SCENARIO=free|paid|closed` і перезапуск API та воркера; інформаційний
режим без оператора - `POST $API/parking/info/sessions {"zone":"underground","enteredAt":"<ISO>"}`.

## 7. Ротація секретів

Загальний порядок: згенерувати нове значення (`openssl rand -base64 48`), оновити секрет у сховищі секретів
середовища, перезапустити API і воркер (rolling restart), перевірити `/ready` і логи. Подвійних ключів
застосунок не підтримує, тому враховуйте наслідки.

Політика (`src/common/config/secret-policy.ts`): з `NODE_ENV=production` застосунок не стартує, якщо будь-яка
змінна `*_SECRET` або `*_PEPPER` (спільна чи модульна) коротша за 32 символи або збігається з відомим
значенням за замовчуванням (`dev-only-*`, `compose-only-*`, `test-only-*`, що завгодно з `changeme`,
значення з `.env.example`, `docker-compose.yml` і seed); `S3_SECRET_ACCESS_KEY` і `SEED_ADMIN_PASSWORD`
перевіряються лише на значення за замовчуванням. Помилка старту називає змінну, але не значення. Тому
новий секрет генеруйте лише випадковим (`openssl rand -base64 48`), ніколи не беріть приклад із репозиторію;
перед rolling restart перевірте конфігурацію на одному екземплярі (`node dist/main.js` впаде одразу з
переліком проблем). Значення `SEED_*` потрібні лише під час seed і в runtime-середовище не передаються.

| Секрет                                       | Наслідок ротації                                                                                                                               | Порядок                                                                                                                          |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `JWT_SECRET`                                 | усі access-токени недійсні: учасники мовчки оновлюються refresh-токеном, адміністратори входять знову; незавершені TOTP-виклики входу недійсні | у години мінімального навантаження                                                                                               |
| `OTP_PEPPER`                                 | коди, надіслані в останні 5 хв, недійсні                                                                                                       | будь-коли; учасник запитує код повторно                                                                                          |
| `VOUCHER_PEPPER`                             | активні коди ваучерів (2 хв) і токени змін валідаторів недійсні; касири вводять PIN знову                                                      | поза піковими годинами каси                                                                                                      |
| `MEMBER_QR_SECRET`                           | QR картки змінюється; застосунок отримує новий у `GET /club/account`                                                                           | будь-коли                                                                                                                        |
| `PARKING_WEBHOOK_SECRET`                     | вебхуки оператора зі старим підписом отримують 401                                                                                             | узгодити час з оператором; він повторює недоставлені вебхуки; `parking-sync` надолужує стан                                      |
| Секрет вебхуків платіжного провайдера        | так само, як вище (мок: `PAYMENTS_MOCK_WEBHOOK_SECRET`)                                                                                        | у кабінеті провайдера і в env одночасно; `payments-reconcile` закриває пропущене                                                 |
| `PAYMENTS_RECEIPT_QR_SECRET`                 | QR для оператора на вже показаних квитанціях паркінгу (`operatorQrPayload`) перестає перевірятися                                              | якщо оператор перевіряє підпис QR (`verifyOperatorQr`), змінити секрет у нього одночасно; поза годинами роботи паркінгу          |
| TOTP адміністратора                          | старий автентифікатор перестає працювати                                                                                                       | скидання за розділом 5.1, новий секрет під час наступного входу                                                                  |
| `DATABASE_URL` (пароль), `REDIS_URL`         | перепідключення                                                                                                                                | створити новий пароль, оновити env, rolling restart, видалити старий                                                             |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`  | presigned URL, видані старим ключем, перестають працювати                                                                                      | новий ключ, rolling restart, вимкнути старий після `S3_PRESIGN_TTL_SECONDS`                                                      |
| `FCM_SERVICE_ACCOUNT_JSON`, `TURBOSMS_TOKEN` | доставки під час перезапуску повторюються BullMQ                                                                                               | новий ключ у Google Cloud / TurboSMS, rolling restart, відкликати старий                                                         |
| Пароль адміністратора                        | -                                                                                                                                              | `PATCH /admin/admin-users/:id {"password": ...}` (owner); доступ діє далі до 30 с на інших репліках                              |
| Ключ і PIN валідатора                        | старий ключ одразу перестає діяти; відкриті зміни закриваються                                                                                 | `POST /admin/validator-devices/:id/rotate-key`, `POST /admin/validator-devices/:id/pin` (6-12 цифр); повторний seed їх не змінює |

## 8. Додати фіскальний номер орендаря

Без фіскального номера в білому списку чеки каси йдуть на модерацію (`fn_not_whitelisted`). Номер
зберігається в канонічному вигляді (лише цифри, без пробілів, дефісів і провідних нулів, 6-20 цифр), тож
`0004000-100-099` і `4000100099` - той самий номер; дубль у будь-якому написанні відхиляється.

```bash
ADMIN=$(curl -s -X POST $API/admin/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"admin@portcity.local","password":"<пароль>"}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).accessToken')
# id орендаря
curl -s "$API/admin/tenants?q=aroma" -H "Authorization: Bearer $ADMIN"
# новий номер одразу active, якщо вказано tenantId
curl -s -X POST $API/admin/fiscal-numbers -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '{"fn":"4000100099","tenantId":"<tenantId>","note":"нова каса"}'
# номери, знайдені в чеках (pending), і підтвердження з прив'язкою
curl -s "$API/admin/fiscal-numbers?status=pending" -H "Authorization: Bearer $ADMIN"
curl -s -X POST $API/admin/fiscal-numbers/<id>/confirm -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' -d '{"tenantId":"<tenantId>"}'
```

Ролі: owner, manager, moderator. Активний номер можна лише заблокувати (`POST /admin/fiscal-numbers/:id/block`),
видалити - лише `pending` або `blocked`. Кожна дія пишеться в аудит. Чеки, що вже чекають модерації, після
підтвердження номера модератор схвалює вручну.

## 9. Модерація чеків

1. Черга: `GET /admin/receipts?status=needs_moderation` (від найстаріших; фільтри `reason`, `userId`, `fn`,
   `from`, `to`); оскаржені - `status=appealed`.
2. Деталі: `GET /admin/receipts/:id` - прапорці ризику, причини модерації (`moderationReasons`), історія,
   підписані посилання на фото, оскарження (перегляд аудитується).
3. Рішення (ролі moderator, manager, owner):
   - схвалити: `POST /admin/receipts/:id/approve` з `Idempotency-Key` і `{"reason": "..."}` (необов'язково) -
     бали нараховуються одразу (якщо леджер недоступний, чек лишається `approved` і його дораховує черга);
   - відхилити: `POST /admin/receipts/:id/reject {"reason": "Чек видано не в ТРЦ Порт City"}` - причину
     бачить учасник, він може один раз оскаржити.
4. Нова каса з чеків - додайте фіскальний номер (розділ 8), щоб наступні чеки проходили автоматично.

Орієнтир: чек на модерації - відповідь учаснику до 24 год (тексти застосунку це обіцяють).

Утримання на перевірку: автосхвалені QR-чеки нових акаунтів (до 30 днів) і на суму понад 500 грн
зараховуються як очікувані бали на 24 год (`verification = pending`); задача `verify-held` кожні 30 хв питає
`TaxReceiptVerifierPort`. Поки адаптер - noop (`unknown`), бали відпускаються після 24 год автоматично
(`verification = unconfirmed`). Понад денний ліміт 150 балів за QR-чеки чек іде на модерацію з причиною
ліміту - це не шахрайство за замовчуванням, а сигнал перевірити учасника.

### 9.1 Звернення в підтримку

1. Черга: `GET /admin/support-requests?status=new` (ролі manager, support; нові першими; `?userId=` - звернення
   учасника); у роботі - `status=in_progress`.
2. Деталі: `GET /admin/support-requests/:id` - тема, пов'язаний об'єкт (`relatedType`/`relatedId`: чек, сесія
   паркінгу, ваучер), текст, підписане посилання на фото (до 1 год), примітка.
3. Обробка: `PATCH /admin/support-requests/:id {"status":"in_progress"}`, далі
   `{"status":"resolved","note":"..."}` або `closed`; закрите звернення фінальне, `resolved` можна повернути в
   роботу. Кожна зміна пишеться в аудит (`support_request.status_change`, `.note`).
4. Учасник отримує «Звернення № N прийнято» одразу; про зміну статусу застосунок не сповіщає (відкрите
   питання) - відповідайте телефоном або e-mail з картки учасника.
5. Лист про нове звернення йде на `SUPPORT_EMAIL` (кілька адрес через кому) через `MAIL_PROVIDER`. Зараз
   реалізовано лише `log`: лист видно тільки в логах воркера (`notifications-events`), тож чергу треба
   дивитися в бек-офісі. Без `SUPPORT_EMAIL` лист пропускається.
6. Персональні дані: примітки не мають містити телефонів, адрес чи даних картки. Після видалення акаунта
   (`user.deleted`) текст звернення замінюється нейтральним, фото видаляється зі сховища (черга
   `admin-events`); номер, тема, статус і примітка лишаються.

Частина звернень - спори щодо паркування з застосунку («Це не моє авто», «сума неправильна», «шлагбаум не
відкрився»): вони не створюють `support_request`, а позначають сесію; список -
`GET /admin/parking/sessions?disputed=true` (розділ 11).

## 10. Що моніторити

| Що                          | Як дивитися                                                                                                                                                         | Реакція                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Живучість і готовність      | `GET /health`, `GET /ready` (API), `GET :3001/health` (воркер)                                                                                                      | перезапуск; `/ready` 503 - перевірити PostgreSQL / Redis                                                                              |
| Черга outbox                | `SELECT count(*), max(now() - occurred_at) FROM outbox_events WHERE published_at IS NULL`; лог `Dropping outbox event`                                              | вік > 1 хв - воркер не працює або Redis недоступний; drop - бракує маршруту                                                           |
| Невдалі задачі BullMQ       | failed-задачі по чергах (Redis, Bull Board / redis-cli), логи воркера                                                                                               | розібрати причину, повторити задачу                                                                                                   |
| Чеки, що застрягли          | `SELECT count(*) FROM receipts WHERE status IN ('uploaded','parsed','auto_approved','approved') AND updated_at < now() - interval '15 minutes'`                     | перевірити `receipts-process` і доступність content / club                                                                            |
| Черга модерації             | кількість і вік `needs_moderation` + `appealed`                                                                                                                     | більше модераторів; вік > 24 год - порушення обіцянки застосунку                                                                      |
| Платежі                     | `pending`/`created` старші 20 хв, частка `failed`, результати `payments-reconcile`                                                                                  | провайдер, вебхуки (401 - підпис), `POST /admin/payments/:id/reconcile`                                                               |
| Оператор паркінгу           | частка `503 PC_PARKING_PROVIDER_UNAVAILABLE`, `providerAvailable: false`, лог `parking-sync`                                                                        | зв'язок з оператором; застосунок працює в інфо-режимі                                                                                 |
| Розбіжність балансів        | warn від `points-balance-drift-nightly` (04:15 Київ)                                                                                                                | розслідувати рядки леджера; кеш балансу не переписується автоматично                                                                  |
| Push і SMS                  | `push_deliveries` зі статусом `failed`; `PC_OTP_DELIVERY_FAILED` у логах                                                                                            | облікові дані FCM / TurboSMS, ліміти провайдера                                                                                       |
| Щоденні звіти               | рядок `daily_stats` за вчора і `complete: true`                                                                                                                     | `POST /admin/reports/daily/recompute`                                                                                                 |
| Помилки HTTP                | частка 5xx, 429 (rate limit), 503 від перевірки адміністратора                                                                                                      | логи з `x-request-id`                                                                                                                 |
| Видалення акаунтів          | лог задачі `account-deletion` (виконані / збої)                                                                                                                     | збої повторюються наступного дня; перевірити `user.deleted` у споживачах (receipts, parking, payments, notifications, rewards, admin) |
| Ops alert оплат паркінгу    | error-лог `Ops alert (...)`; `GET /admin/audit?action=parking_payment.ops_alert&from=<ISO>`                                                                         | розділ 12; `manual_review` - звірка з оператором того ж дня                                                                           |
| Автоповернення              | `SELECT id, updated_at FROM payments WHERE meta #>> '{_internal,autoRefund,state}' = 'queued' AND updated_at < now() - interval '2 hours'`                          | провайдер повернень; `POST /admin/payments/:id/reconcile`; розділ 12                                                                  |
| Оплати паркінгу без рішення | `SELECT count(*) FROM parking_payment_links WHERE outcome IS NULL AND created_at < now() - interval '15 minutes'` (і `outcome='applied' AND registered_at IS NULL`) | `payments-sweep` кожні 5 хв; більше 15 хв - воркер, оператор або Redis                                                                |
| Чеки в утриманні            | `SELECT count(*) FROM receipts WHERE verification = 'pending'`; частка модерацій з причиною денного ліміту                                                          | нормальний стан до підключення перевірки ДПС; різке зростання - перевірити учасників                                                  |
| Звернення в підтримку       | `GET /admin/support-requests?status=new` - кількість і вік                                                                                                          | розділ 9.1; вік > 24 год - порушення обіцянки застосунку                                                                              |

## 11. Типові ситуації

- **Учасник оплатив, а шлагбаум не відкрився.** `GET /admin/payments?userId=` -> якщо `succeeded`, перевірити
  сесію (`GET /admin/parking/sessions?userId=`) і логи `parking-events` (реєстрація в операторі повторюється);
  якщо `pending` - `POST /admin/payments/:id/reconcile`.
- **Адміністратора деактивовано, а він ще працює.** Перевірка в `AdminGuard` кешується до 30 с на кожній
  репліці (`ADMIN_ACCESS_CACHE_SECONDS`); після цього запити отримують 403 `PC_ADMIN_INACTIVE`.
- **Тривога.** Черговий вмикає `parking.air_raid` (розділ 6); виїзд у вікні закривається як `closed_free`.
  Ручне безкоштовне закриття: `POST /admin/parking/sessions/:id/close-free`.
- **Ручне коригування балів.** `POST /admin/adjustments` (до 500 балів застосовується одразу, більше -
  потрібне затвердження іншим адміністратором `POST /admin/adjustments/:id/approve`). Ліміт рахується й
  накопичено: самостійно затверджені коригування заявника за день Києва і рахунку за 24 год понад поріг теж
  потребують другого адміністратора (`second_approval_reason`).
- **«Це не моє авто» / «сума неправильна» / «шлагбаум не відкрився».** Учасник позначив сесію спірною:
  вона зникла з героя, нагадувань і оплати немає. `GET /admin/parking/sessions?disputed=true` -> звірити з
  оператором (камери, талон); за потреби `POST /admin/parking/sessions/:id/close-free` або повернення платежу.
  Зняти позначку може лише підтримка вручну (відкрите питання).

## 12. Паркінг: ops alert і автоматичні повернення

Оплата з застосунку, яку сесія вже не може використати, не губиться: parking приймає рішення один раз на
платіж (`parking_payment_links.outcome`) і публікує `parking.payment.ops_alert` (лише аудит: запис
`audit_logs` з `action = parking_payment.ops_alert`, `entity_type = payment`, і error-лог воркера
`Ops alert (<alert>) for payment <id>, session <id>: <reason>`).

| `alert` / `reason`                        | Що сталося                                                                  | Що робить система                                                                                                                                 | Що робити черговому                                                                                              |
| ----------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `refund_queued` / `session_closed`        | гроші прийшли після виїзду (часто пізній успіх `late: true`)                | `PAYMENTS_PORT.requestRefund` -> задача `auto-refund` (12 спроб від 1 хв); учаснику - «Кошти за паркінг повернуто» після підтвердження провайдера | нічого, якщо повернення дійшло; інакше - див. нижче                                                              |
| `refund_queued` / `already_paid`          | ту саму годину вже оплатила інша спроба (подвійне натискання, два пристрої) | те саме                                                                                                                                           | те саме                                                                                                          |
| `refund_queued` / `session_not_found`     | платіж без сесії (сесію видалено або дані пошкоджено)                       | те саме, без зв'язку з сесією                                                                                                                     | перевірити платіж і учасника                                                                                     |
| `manual_review` / `session_closed_unpaid` | учасник натиснув «Я вже виїхав» з боргом, потім оплатив                     | гроші лишаються (покривають спірну суму), повернення немає                                                                                        | звірити з оператором; якщо оплата зайва - `POST /admin/payments/:id/refund` з `Idempotency-Key` (owner, manager) |

Перевірка автоповернення: `GET /admin/payments/:id` (службова частина `meta._internal.autoRefund.state`:
`queued` -> `done` або `skipped`, якщо грошей уже немає; статус платежу `refunded`/`partially_refunded`).
Якщо стан `queued` довше 2 год (запит у розділі 10), провайдер не приймає повернення: щогодинне звіряння
перепоставить задачу, а для живого еквайра - повернення через кабінет провайдера і
`POST /admin/payments/:id/reconcile`. Повернення ніколи не виконується двічі (резерв під блокуванням і ключ
`auto-refund:<paymentId>` у провайдера).

Подвійна оплата «застосунок + паркомат» (оператор уже бачить оплату з паркомата, а з застосунку теж прийшли
гроші за активну сесію) автоматично **не** повертається: оплата застосовується до сесії, повернення - за
зверненням учасника вручну (`POST /admin/payments/:id/refund`). Це рішення за замовчуванням
(`docs/INTEGRATION_NOTES.md`). `payments-sweep` (кожні 5 хв) повторює незастосовані оплати, реєстрацію в
операторі й непідтверджені запити повернень за останні 48 год.
