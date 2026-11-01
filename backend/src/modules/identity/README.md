# Модуль identity

Вхід учасників за SMS-кодом, сесії (access JWT + refresh-токени з ротацією), профіль (стать, місто,
діти, прогрес заповнення), згоди та актуальні юридичні документи, пристрої та push-токени,
видалення акаунта з налаштовуваним періодом охолодження, експорт персональних даних, вхід у
бек-офіс (пароль + TOTP, обов'язковий для owner/manager, блокування після невдалих спроб), пошук
учасників і облікові записи адміністраторів.

English summary: OTP login hardened against brute force and SMS pumping (cooldown, per-phone,
per-day and per-IP-network limits under advisory locks, wrong-code lock, global SMS budget,
captcha hook), rotating refresh tokens with reuse detection, profile with gender/city/children and
`profileCompletion` (per-field `user.profile_field_completed` events for club bonuses), consents
with versions from `GET /legal/documents`, account deletion with `ACCOUNT_DELETION_GRACE_DAYS`,
admin login with mandatory TOTP for owner/manager, single-use TOTP challenges, per-account lockout
with backoff, scrypt N = 2^17 with rehash on login and a scrypt semaphore. Provides `IDENTITY_PORT`;
depends on the common layer only.

## Структура

| Шлях                                                            | Що всередині                                                                                                                                                                                                             |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `domain/`                                                       | чиста логіка з табличними тестами: OTP (ліміти, блокування, бюджет SMS), ротація refresh, згоди, юридичні документи, профіль і прогрес, діти, вхід адміністратора і блокування, сплески невдач, member code, TOTP, пошук |
| `services/identity.store.ts`                                    | межа персистентності (`IdentityStore`, unit of work `run()`), Prisma-реалізація в `prisma-identity.store.ts`                                                                                                             |
| `services/*.service.ts`                                         | `AuthService`, `SessionService`, `DevicesService`, `ProfileService`, `ChildrenService`, `AccountDeletionService`, `AdminAuthService`, `AdminUsersService`, `AdminStaffService`, `IdentityPortService`                    |
| `services/profile-fields.ts`                                    | оголошення заповнених полів профілю (`user.profile_field_completed`) під блокуванням рядка учасника                                                                                                                       |
| `services/captcha.port.ts`                                      | `CaptchaVerifierPort` і `NoopCaptchaVerifier` (хук капчі для `otp/request`)                                                                                                                                              |
| `services/sms.port.ts`, `turbosms.adapter.ts`, `sms.factory.ts` | порт SMS і адаптери (`log` для розробки, `turbosms`)                                                                                                                                                                     |
| `controllers/`                                                  | `auth`, `me` (з дітьми), `legal`, `admin/auth` (з enrollment TOTP), `admin/users`, `admin/admin-users`                                                                                                                   |
| `jobs/`                                                         | `account-deletion` (логіка - функція `runAccountDeletion`, процесор лише з'єднує)                                                                                                                                       |
| `testing/`                                                      | `InMemoryIdentityStore` (серіалізовані unit of work замість блокувань БД), `InMemorySmsAdapter`, `RecordingCaptchaVerifier`, фікстури `createIdentityHarness`                                                          |

Спільний шар, змінений разом із модулем: `src/common/throttling/ip-key.ts` (ключ ліміту IP, IPv6 -> /64,
також трекер глобального throttler), `src/common/auth/concurrency-limiter.ts` (семафор scrypt),
`src/common/auth/crypto.ts` (`PASSWORD_SCRYPT_PARAMS`, `needsRehash`), `src/common/config/secret-policy.ts`
і `trust-proxy.ts`, `src/common/logging` (редагування заголовків, URL без query), `src/common/health`
(`/ready` з лімітом і кешем).

## Модель даних (`prisma/schema/identity.prisma`)

- `User` - учасник: телефон E.164 (унікальний), e-mail (унікальний, у нижньому регістрі), ім'я,
  прізвище, дата народження, `gender` (`female | male | other | unspecified`, null = не відповів),
  `city`, статус `active | blocked | deleted`, `memberCode` (9 цифр, остання - контрольна цифра Луна),
  `profileCompletedAt`, `completedProfileFields` (поля, за які вже опубліковано
  `user.profile_field_completed`), `deletedAt`. Рядки ніколи не видаляються: після видалення акаунта
  лишається анонімізований рядок (телефон `anon:<sha256(id)[0..24]>`, без імені, e-mail, дати
  народження, статі й міста), тож леджер балів і чеки зберігають анонімного власника.
- `Child` - дитина учасника: лише місяць і рік народження (без імен і точних дат), стать; до 6 на
  учасника. Видаляється разом з анонімізацією акаунта.
- `Device` - встановлення застосунку: платформа, модель, версія, `fingerprint` (повторне використання
  рядка при повторному вході), `pushToken`, `pushEnabled`, `lastSeenAt`.
- `Consent` - згода за метою (`program | marketing | profiling`) з версією тексту; нова версія -
  новий рядок, відкликання ставить `revokedAt`. Поточний стан = останній рядок за метою.
- `OtpChallenge` - SMS-код: зберігається лише `HMAC-SHA256(OTP_PEPPER, challengeId, phone, code)`,
  `expiresAt` (+5 хв), `attempts`/`maxAttempts` (5), `ip` = ключ ліміту (IPv4 або мережа IPv6 /64,
  напр. `2001:db8:1:2::/64`), fingerprint, `consumedAt`. Індекс `created_at` - для глобального бюджету SMS.
- `RefreshToken` - SHA-256 від непрозорого 32-байтного токена, `family` (одна на вхід), `deviceId`,
  `expiresAt` (+60 днів), `revokedAt`, `replacedById`.
- `AdminUser` - e-mail, scrypt-хеш пароля у форматі PHC, `totpSecret` (null = 2FA вимкнено),
  `totpLastStep` (захист від повторного коду), роль, `active`, `lastLoginAt`, `failedLoginCount`,
  `lastFailedLoginAt`, `lockedUntil` (блокування з backoff), `loginChallengeId` /
  `loginChallengeAttempts` (єдиний дійсний TOTP-виклик входу і кількість спроб за ним).
- `AccountDeletionRequest` - `requestedAt`, `executeAfter` (+`ACCOUNT_DELETION_GRACE_DAYS`, типово 30),
  `executedAt`, `cancelledAt`, причина.

SQL, який Prisma не виражає (CHECK для дітей і лічильників, обмеження імен полів профілю, заповнення
`completed_profile_fields` для наявних учасників, нормалізація старих IPv4-mapped адрес): міграція
`prisma/schema/migrations/20261101180000_review_fixes` (розділи 2.1, 3.1, 3.2). Seed - `prisma/seed.ts`.
Архів початкових файлів - `docs/pending-sql/applied/identity.*`.

## Статусні машини

```
User:             active <-> blocked ; active | blocked -> deleted (лише задача account-deletion)
DeletionRequest:  pending -> executed | cancelled
OtpChallenge:     issued -> consumed | expired | burnt (5 невдалих спроб) ; новий запит анулює попередній
Phone (OTP):      open -> locked (10 неправильних кодів за 24 год) -> open (коли невдачі виходять з вікна)
RefreshToken:     active -> rotated (replacedById) | revoked (logout, блокування, reuse) | expired
AdminUser login:  open -> locked (5 невдач поспіль; 5 хв, далі x2 до 1 год) -> open ; успіх скидає лічильник
TOTP challenge:   issued -> consumed (успіх) | dead (5 кодів, новий вхід, зміна пароля, 5 хв)
```

## Потоки

**Запит коду (`POST /auth/otp/request`).** Номер нормалізується, IP зводиться до ключа ліміту
(`ipRateLimitKey`: IPv4 як є, IPv6 - мережа /64, IPv4-mapped -> IPv4). Спершу без транзакції
перевіряються ліміти й м'які пороги капчі; якщо номер має від `OTP_CAPTCHA_PHONE_THRESHOLD` кодів за
24 год або мережа від `OTP_CAPTCHA_IP_THRESHOLD` за вікно IP, викликається `CaptchaVerifierPort`
(`captchaToken` з тіла; відмова - `403 PC_OTP_CAPTCHA_REQUIRED`, `details.reason` `missing | invalid`).
Потім у транзакції під advisory-блокуваннями `pg_advisory_xact_lock(7101, hashtext(phone))` і
`(7102, hashtext(ip))` ліміти перераховуються і виклик вставляється - паралельні запити не
перевищують жодного ліміту. Правила (у порядку перевірки, `domain/otp.ts decideOtpRequest`):

1. блокування номера: 10 неправильних кодів за 24 год (сумарно за всіма викликами) -> `429 PC_OTP_LOCKED`
   з `retryAfterSeconds` / `lockedUntil` (і нові коди, і перевірка);
2. пауза між кодами `OTP_RESEND_COOLDOWN_SECONDS` (60 с) -> `429 PC_OTP_RATE_LIMITED`, `scope: cooldown`;
3. 3 коди на номер за 10 хв (`scope: phone`), 4. 5 кодів на номер за 24 год (`scope: phone_daily`),
5. 10 кодів з мережі за годину (`scope: ip`); кожна відмова має `retryAfterSeconds` і `retryAt`;
6. глобальний бюджет `SMS_DAILY_BUDGET` на добу за Києвом: після вичерпання `503
   PC_OTP_SMS_BUDGET_EXHAUSTED` до півночі; на `SMS_BUDGET_ALERT_PERCENT` (80 %) - warn у лозі (раз на
   добу на репліку), при вичерпанні - error. Демо-номери з `OTP_STATIC_CODES` SMS не шлють і бюджет
   не перевіряють.

Відповідь містить `resendAvailableAt` - найраніший момент наступного коду з урахуванням усіх правил
(зворотний відлік на екрані). На маршруті також стоїть throttler 10/год на IP-мережу.

**Перевірка коду (`POST /auth/otp/verify`).** Якщо номер заблоковано - `429 PC_OTP_LOCKED`. Береться
останній виклик номера; під тим самим блокуванням номера ще раз перевіряється ліміт невдач і
атомарно зараховується спроба (паралельні вгадування не дають ні більше 5 спроб на код, ні
перевищення ліміту за 24 год), HMAC порівнюється в сталий час, у транзакції виклик позначається
використаним, учасник знаходиться або створюється (member code з повтором при колізії), пристрій
прив'язується за fingerprint, застосовуються передані згоди (без `version` - поточна версія з
`GET /legal/documents`), старі сесії пристрою відкликаються, видаються токени. Новий учасник -
`user.registered`. Демо-номери з `OTP_STATIC_CODES` отримують фіксований код без SMS; у production
вони дозволені лише з `ALLOW_STATIC_OTP=true` і 8-значними кодами.

**Сесії.** Access JWT HS256 на 15 хв (`sub`, `typ: member`, `did`). `POST /auth/refresh` ротує токен
у межах сім'ї; повторне пред'явлення ротованого токена через понад 10 с відкликає сім'ю
(`PC_REFRESH_REUSED`), у межах 10 с - просто `PC_REFRESH_INVALID`. Заблокований учасник при refresh
отримує 403 і втрачає сім'ю. `POST /auth/logout` відкликає сесії пристрою / сім'ї / всі і прибирає
push-токени.

**Профіль.** `GET /me` повертає профіль (з `gender`, `city`), дітей, `profileCompletion
{ percent, missing[], bonusPerField, bonusComplete }` (7 полів: firstName, lastName, birthDate, email,
gender, city, children; `children` заповнене з першою дитиною; бали - з `PROFILE_BONUS_PER_FIELD` /
`PROFILE_BONUS_COMPLETE`, ті самі змінні читає club), згоди, запит на видалення, поточний пристрій.
`PATCH /me` (ім'я, прізвище, дата народження 14-120 років, e-mail, стать, місто). Перше заповнення
імені, прізвища й дати народження - `user.profile_completed` (вітальний бонус club). Перше заповнення
кожного з 7 полів - `user.profile_field_completed { userId, field, completedAt, allFieldsCompleted }`
рівно один раз на поле (очищення й повторне заповнення нічого не публікує; `allFieldsCompleted = true`
лише на події, що завершує набір). Рішення приймається під `SELECT ... FOR UPDATE` рядка учасника, тож
паралельні запити не дублюють подій.

**Діти.** `GET/POST/PATCH/DELETE /me/children`: місяць (1-12) і рік народження, стать (типово
`unspecified`); не майбутній місяць і не старше 18 років (за календарем Києва), до 6 дітей
(`422 PC_USER_CHILD_LIMIT`; перевірка під блокуванням рядка учасника). Чужа або неіснуюча дитина -
`404 PC_USER_CHILD_NOT_FOUND`.

**Згоди й документи.** `GET /legal/documents` (публічний) - поточні тексти згод з версіями й URL з
`LEGAL_*` і посилання на політику конфіденційності. `POST /me/consents` надає (версія опційна -
поточна з конфігурації) або відкликає згоди; згоду `program` відкликати не можна.

**Пристрої і push.** `POST /me/devices` записує push-токен пристрою з access-токена. Push-токен
однозначно визначає встановлення, і отримати його може лише сам застосунок на цьому пристрої, тож
пред'явлення токена доводить володіння: він знімається з усіх інших рядків (типово інший учасник на
тому ж телефоні). Перенесення пишеться в аудит (`device.push_token_moved`, актор - поточний учасник,
сутність - поточний пристрій, `after.detachedFromOtherDevices`) і в лог з id лише поточного пристрою;
id іншого учасника чи його пристрою ніде не з'являється. Те саме при вході з `device.pushToken`.

**Видалення й експорт.** `DELETE /me` створює запит (ідемпотентно) з `executeAfter = +ACCOUNT_DELETION_GRACE_DAYS`
(типово 30) і подією `user.deletion_requested`; відповідь містить `executeAfter` і `graceDays`. Скасування -
`DELETE /me/deletion`. Щоденна задача анонімізує акаунт: профіль (з статтю й містом), діти, деталі
пристроїв і push-токени, сесії та згоди, OTP-виклики старого номера; публікує `user.deleted`, пише
аудит від `system/account-deletion`. `GET /me/export` - JSON з даними identity (профіль, діти, пристрої
без токенів, історія згод, запити на видалення, останні 100 сесій).

**Бек-офіс.** `POST /admin/auth/login`:

- заблокований акаунт (`lockedUntil` у майбутньому) - `429 PC_ADMIN_LOGIN_LOCKED` з
  `retryAfterSeconds`, пароль навіть не перевіряється;
- пароль перевіряється завжди (невідомий e-mail теж проходить scrypt) за семафором: не більше
  `ADMIN_SCRYPT_MAX_CONCURRENT` (4) перевірок одночасно і `ADMIN_SCRYPT_MAX_QUEUE` (16) у черзі, решта -
  `429 PC_ADMIN_LOGIN_BUSY` (захист пам'яті: один scrypt N = 2^17 бере 128 МіБ);
- нові паролі хешуються з N = 2^17 (`ADMIN_PASSWORD_SCRYPT_LOG_N`); слабший збережений хеш (seed до
  01.11.2026 писав `ln=14`, тепер пише `ln=17`) після успішної перевірки пароля замінюється (`needsRehash`);
- кожен неправильний пароль або TOTP-код відомого акаунта збільшує `failedLoginCount` під блокуванням
  рядка (аудит `admin_user.login_failed` з лічильником); від 5-ї невдачі акаунт блокується на 5 хв, далі
  вдвічі довше на кожну наступну до 1 год (аудит `admin_user.login_locked`, warn у лозі); невдача,
  старша за 24 год, починає лічильник заново; успішний вхід (і зміна пароля власником) скидає його;
- сплеск невдач з однієї IP-мережі (`ADMIN_LOGIN_BURST_THRESHOLD` = 20 за 10 хв, будь-які e-mail) -
  один warn і аудит `admin_user.login_failed_burst` за вікно;
- ролі з `ADMIN_REQUIRE_TOTP_ROLES` (типово owner, manager) без TOTP: `403 PC_ADMIN_TOTP_SETUP_REQUIRED`
  з `details.enrollmentToken` (5 хв, прив'язаний до хешу пароля). `POST /admin/auth/totp/enroll`
  повертає новий секрет, otpauth URI і setup-токен; `POST /admin/auth/totp/enroll/confirm` з першим
  кодом вмикає TOTP і в тій самій транзакції завершує вхід (токен). Вимкнути TOTP для таких ролей не
  можна (`409 PC_ADMIN_TOTP_REQUIRED_FOR_ROLE`);
- з увімкненим TOTP без коду - `401 PC_ADMIN_TOTP_REQUIRED` з `details.challengeToken`. Виклик
  одноразовий і приймає до `ADMIN_TOTP_CHALLENGE_MAX_ATTEMPTS` (5) кодів: його jti зберігається в
  `loginChallengeId`, кожна спроба атомарно збільшує `loginChallengeAttempts`, успіх очищує jti, новий
  вхід замінює виклик. Невірний код - `401 PC_ADMIN_TOTP_INVALID` з `details.attemptsLeft`.

Кожен прийнятий код TOTP займає свій часовий крок (`totpLastStep`), повтор - `PC_ADMIN_TOTP_INVALID`.
Пошук учасників маскує телефони, перегляд картки аудитується. Спільний `AdminGuard` на кожному
`/admin/*` перевіряє активність і роль через `IDENTITY_PORT.getAdminAccess` (кеш 30 с).

## Прийняті ризики (рішення, не змінювати без продукту)

1. **Access-токен учасника stateless на 15 хв.** Запити учасника не перевіряють БД на кожному виклику:
   блокування, вихід чи видалення діють на вже виданий access-токен до 15 хв (refresh після блокування
   відмовляє одразу, ендпоїнти identity самі перевіряють статус). Прийнято заради продуктивності.
2. **`PATCH /me` повертає 409 `PC_USER_EMAIL_TAKEN`** для e-mail іншого учасника, тобто дає
   автентифікованому учаснику дізнатися, чи зареєстрований e-mail. Прийнято: потрібна сесія учасника,
   діє глобальний throttler; альтернатива (підтвердження e-mail листом) - поза обсягом.
3. **Блокування адміністратора видає існування акаунта і дозволяє DoS.** Після 5 невдач відповідь
   `PC_ADMIN_LOGIN_LOCKED` відрізняється від невідомого e-mail, і зловмисник може тримати акаунт
   заблокованим. Пом'якшено короткими блокуваннями з backoff (макс. 1 год), throttler 10/хв на IP і
   аудитом; адреси бек-офісу не публічні.
4. **Детектор сплесків і попередження бюджету SMS - у пам'яті репліки.** Жорсткі ліміти (лічильники в
   БД) від цього не залежать; при кількох репліках поріг сплеску фактично на репліку.
5. **Капча - noop.** Хук викликається на м'яких порогах, але поки пропускає все; жорсткі ліміти діють.
6. **Демо-коди `OTP_STATIC_CODES` підпадають під ті самі ліміти номера** (пауза, 3/10 хв, 5/добу), крім
   бюджету SMS.

## Ендпоїнти (префікс `/api/v1`)

| Метод і шлях                                 | Доступ                             | Опис                                                                                     |
| -------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------- |
| `POST /auth/otp/request`                     | публічний, throttler 10/год на IP  | надіслати код; `resendAvailableAt`; 429 `PC_OTP_RATE_LIMITED` / `PC_OTP_LOCKED`, 403 капча, 503 бюджет |
| `POST /auth/otp/verify`                      | публічний                          | код -> токени, `isNewUser`, `user`, `deviceId`; згоди без версії - поточна               |
| `POST /auth/refresh`                         | публічний                          | ротація refresh-токена                                                                   |
| `POST /auth/logout`                          | member                             | завершити сесії (пристрій / вхід / усі)                                                  |
| `GET /legal/documents`                       | публічний                          | поточні документи згод: мета, версія, URL, обов'язковість; політика конфіденційності     |
| `GET /me`                                    | member                             | профіль, діти, `profileCompletion`, згоди, запит на видалення, поточний пристрій         |
| `PATCH /me`                                  | member                             | ім'я, прізвище, дата народження, e-mail, стать, місто                                    |
| `GET /me/children`                           | member                             | діти (`items`, `max` = 6)                                                                |
| `POST /me/children`                          | member                             | додати дитину (201)                                                                      |
| `PATCH /me/children/:id`                     | member                             | змінити місяць, рік, стать                                                               |
| `DELETE /me/children/:id`                    | member                             | видалити дитину (204)                                                                    |
| `POST /me/consents`                          | member                             | надати або відкликати згоди                                                              |
| `GET /me/devices`                            | member                             | список пристроїв                                                                         |
| `POST /me/devices`                           | member                             | push-токен і дані поточного пристрою                                                     |
| `DELETE /me/devices/:id`                     | member                             | вийти з пристрою                                                                         |
| `DELETE /me`                                 | member                             | запит на видалення акаунта (202, `executeAfter`, `graceDays`)                            |
| `DELETE /me/deletion`                        | member                             | скасувати запит на видалення                                                             |
| `GET /me/export`                             | member                             | експорт персональних даних identity                                                      |
| `POST /admin/auth/login`                     | публічний, throttler 10/хв на IP   | вхід адміністратора                                                                      |
| `POST /admin/auth/totp`                      | публічний, throttler 10/хв на IP   | другий крок входу (одноразовий виклик, 5 спроб)                                          |
| `POST /admin/auth/totp/enroll`               | публічний, throttler 10/хв на IP   | обов'язковий TOTP при вході, крок 1: enrollment-токен -> секрет                         |
| `POST /admin/auth/totp/enroll/confirm`       | публічний, throttler 10/хв на IP   | крок 2: перший код -> TOTP увімкнено + admin-токен                                      |
| `GET /admin/auth/me`                         | admin                              | власний обліковий запис                                                                  |
| `POST /admin/auth/totp/setup`                | admin                              | новий секрет TOTP і setup-токен                                                          |
| `POST /admin/auth/totp/confirm`              | admin                              | увімкнути TOTP першим кодом                                                              |
| `POST /admin/auth/totp/disable`              | admin                              | вимкнути TOTP поточним кодом (не для owner/manager)                                      |
| `GET /admin/users?q=&status=&cursor=&limit=` | owner, manager, support, moderator | пошук за телефоном, member code, e-mail, ім'ям; телефони замасковані                     |
| `GET /admin/users/:id`                       | owner, manager, support, moderator | картка учасника (замаскований телефон), аудит перегляду                                  |
| `POST /admin/users/:id/block`                | owner, manager                     | блокування з причиною, подія `user.blocked`                                              |
| `POST /admin/users/:id/unblock`              | owner, manager                     | розблокування з причиною, подія `user.unblocked`                                         |
| `POST /admin/users/:id/revoke-sessions`      | owner, manager, support            | вийти на всіх пристроях учасника                                                         |
| `GET /admin/admin-users`                     | owner                              | облікові записи бек-офісу                                                                |
| `POST /admin/admin-users`                    | owner                              | створити (пароль від 12 символів, scrypt N = 2^17)                                       |
| `PATCH /admin/admin-users/:id`               | owner                              | роль, ім'я, пароль (скидає блокування), активність; захист останнього owner             |

## Події outbox

| Подія                          | Коли                                                    | Payload                                              | Споживач        |
| ------------------------------ | ------------------------------------------------------- | ---------------------------------------------------- | --------------- |
| `user.registered`              | перший вхід                                             | `userId, memberCode, deviceId, registeredAt`         | club            |
| `user.profile_completed`       | ім'я, прізвище й дата народження вперше заповнені       | `userId, completedAt`                                | club            |
| `user.profile_field_completed` | кожне з 7 полів профілю вперше заповнене (раз на поле)  | `userId, field, completedAt, allFieldsCompleted`     | club            |
| `user.device_registered`       | новий пристрій або зміна push-токена/дозволу            | `userId, deviceId, platform, pushEnabled`            | лише аудит      |
| `user.blocked`                 | блокування адміністратором                              | `userId, reason`                                     | лише аудит      |
| `user.unblocked`               | розблокування адміністратором                           | `userId, reason`                                     | лише аудит      |
| `user.deletion_requested`      | `DELETE /me`                                            | `userId, requestId, executeAfter`                    | notifications   |
| `user.deletion_cancelled`      | `DELETE /me/deletion`                                   | `userId, requestId, cancelledAt`                     | notifications   |
| `user.deleted`                 | анонімізація задачею                                    | `userId, requestId, deletedAt`                       | модулі з даними |

Усі події публікуються в тій самій транзакції, що й зміна та рядок аудиту. `user.profile_field_completed`
споживає club (бонуси за поля профілю), тому в списку "лише аудит" її немає.

Записи аудиту без подій: `admin_user.login`, `login_failed` (з `failedLoginCount`), `login_locked`,
`login_failed_burst` (актор `system/admin-login-guard`), `totp_enable` (`via: login_enrollment` для
обов'язкового налаштування), `totp_disable`, `device.push_token_moved`.

## Порт `IDENTITY_PORT`

`IdentityPortService`: `getUser(userId, tx?)`, `getUsers(ids)`, `getDevice(id)`,
`resolveMemberCode(code)`, `listPushDevices(userId)`, `hasConsent(userId, purpose)`,
`listMarketingAudience(cursor, limit)`, `getAdminAccess(adminId)`. Лише читання. `UserSummary`
не змінено (стать, місто й діти через порт не видаються).

## Задачі (черга `account-deletion`)

| Задача        | Розклад                                                                                           | Що робить                                                                                                                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run`         | `ACCOUNT_DELETION_CRON`, за замовчуванням `15 4 * * *` (Europe/Kyiv), id `account-deletion-daily` | виконує прострочені запити (до `ACCOUNT_DELETION_BATCH_SIZE`, кожен у власній транзакції), потім чистить OTP-виклики старші `OTP_RETENTION_DAYS` і refresh-токени, що прострочені/відкликані понад `REFRESH_RETENTION_DAYS` тому |
| `execute-one` | вручну, `{ requestId }`                                                                           | виконати один запит (ідемпотентно)                                                                                                                                                                                               |

## Змінні середовища (секція `identity`, `identity.config.ts`)

| Змінна                                                                         | За замовчуванням                                                 | Призначення                                                                 |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `OTP_TTL_SECONDS`, `OTP_CODE_LENGTH`, `OTP_MAX_ATTEMPTS`                       | 300, 6, 5                                                        | життя коду, довжина, спроби                                                 |
| `OTP_PHONE_LIMIT`, `OTP_PHONE_WINDOW_SECONDS`                                  | 3, 600                                                           | ліміт на номер                                                              |
| `OTP_IP_LIMIT`, `OTP_IP_WINDOW_SECONDS`                                        | 10, 3600                                                         | ліміт на IP (IPv6 - мережа /64)                                             |
| `OTP_RESEND_COOLDOWN_SECONDS`                                                  | 60                                                               | пауза між кодами, `resendAvailableAt`                                       |
| `OTP_PHONE_DAILY_LIMIT`                                                        | 5                                                                | кодів на номер за 24 год                                                    |
| `OTP_VERIFY_FAILURE_LIMIT`, `OTP_VERIFY_FAILURE_WINDOW_SECONDS`                | 10, 86400                                                        | блокування номера після неправильних кодів                                  |
| `SMS_DAILY_BUDGET`, `SMS_BUDGET_ALERT_PERCENT`                                 | 5000, 80                                                         | глобальний бюджет SMS на добу (Київ) і поріг попередження                   |
| `OTP_CAPTCHA_PHONE_THRESHOLD`, `OTP_CAPTCHA_IP_THRESHOLD`                      | 3, 5                                                             | м'які пороги капчі (0 - вимкнено)                                           |
| `OTP_DEV_ECHO`                                                                 | false                                                            | повертати код у відповіді (заборонено в production)                         |
| `OTP_STATIC_CODES`, `ALLOW_STATIC_OTP`                                         | порожньо, false                                                  | демо-номери без SMS; у production лише з прапорцем і 8-значними кодами      |
| `SMS_PROVIDER`                                                                 | `log`                                                            | `log` (лише розробка; у production відмовляє) або `turbosms`                |
| `TURBOSMS_TOKEN`, `TURBOSMS_SENDER`, `TURBOSMS_API_URL`, `TURBOSMS_TIMEOUT_MS` | -, `PortCity`, `https://api.turbosms.ua/message/send.json`, 5000 | TurboSMS (токен обов'язковий при `turbosms`)                                |
| `ADMIN_ACCESS_TTL_SECONDS`                                                     | 28800                                                            | життя admin-токена                                                          |
| `ADMIN_CHALLENGE_TTL_SECONDS`, `ADMIN_TOTP_SETUP_TTL_SECONDS`                  | 300, 600                                                         | строк дії TOTP-виклику / enrollment-токена і setup-токена                   |
| `ADMIN_TOTP_ISSUER`, `ADMIN_TOTP_TOLERANCE_SECONDS`                            | `PortCity Admin`, 30                                             | підпис в authenticator, допуск годинника                                    |
| `ADMIN_REQUIRE_TOTP_ROLES`                                                     | `owner,manager`                                                  | ролі з обов'язковим TOTP (`none` - вимкнути)                                |
| `ADMIN_TOTP_CHALLENGE_MAX_ATTEMPTS`                                            | 5                                                                | кодів за одним викликом входу                                               |
| `ADMIN_LOGIN_LOCK_THRESHOLD`, `ADMIN_LOGIN_LOCK_BASE_SECONDS`, `ADMIN_LOGIN_LOCK_MAX_SECONDS` | 5, 300, 3600                                      | блокування адміністратора з backoff                                         |
| `ADMIN_LOGIN_FAILURE_WINDOW_SECONDS`                                           | 86400                                                            | після цієї паузи лічильник невдач починається заново                        |
| `ADMIN_LOGIN_BURST_THRESHOLD`, `ADMIN_LOGIN_BURST_WINDOW_SECONDS`              | 20, 600                                                          | сплеск невдач з IP-мережі -> warn і аудит                                   |
| `ADMIN_PASSWORD_SCRYPT_LOG_N`                                                  | 17                                                               | вартість scrypt нових паролів (у production не менше 17)                    |
| `ADMIN_SCRYPT_MAX_CONCURRENT`, `ADMIN_SCRYPT_MAX_QUEUE`                        | 4, 16                                                            | семафор перевірок пароля, далі 429                                          |
| `PROFILE_BONUS_PER_FIELD`, `PROFILE_BONUS_COMPLETE`                            | 10, 20                                                           | бали в `profileCompletion` (ті самі змінні нараховує club)                  |
| `LEGAL_PROGRAM_VERSION`, `LEGAL_PROGRAM_URL`                                   | `2026-10`, `https://portcity.com.ua/loyalty/rules`               | документ згоди `program`                                                    |
| `LEGAL_MARKETING_VERSION`, `LEGAL_MARKETING_URL`                               | `2026-10`, `.../loyalty/marketing-consent`                       | документ згоди `marketing`                                                  |
| `LEGAL_PROFILING_VERSION`, `LEGAL_PROFILING_URL`                               | `2026-10`, `.../loyalty/profiling-consent`                       | документ згоди `profiling`                                                  |
| `LEGAL_PRIVACY_POLICY_URL`                                                     | `https://portcity.com.ua/privacy`                                | політика конфіденційності                                                   |
| `ACCOUNT_DELETION_CRON`, `ACCOUNT_DELETION_BATCH_SIZE`                         | `15 4 * * *`, 100                                                | розклад і партія задачі                                                     |
| `ACCOUNT_DELETION_GRACE_DAYS`                                                  | 30                                                               | період охолодження `DELETE /me`                                             |
| `OTP_RETENTION_DAYS`, `REFRESH_RETENTION_DAYS`                                 | 7, 60                                                            | строки зберігання для очищення                                              |

Спільні змінні: `JWT_SECRET` (також ключ підпису TOTP-викликів), `JWT_ACCESS_TTL_SECONDS`,
`REFRESH_TOKEN_TTL_DAYS`, `OTP_PEPPER`, `ADMIN_ACCESS_CACHE_SECONDS`, `CORS_ORIGINS` (у production без
`*`) і `TRUST_PROXY`:

- `false` - проксі немає, IP клієнта = адреса сокета;
- число N - N reverse proxy перед застосунком (балансувальник = 1, CDN + балансувальник = 2);
- список адрес/CIDR (і `loopback`, `linklocal`, `uniquelocal`) - довіряти лише проксі з цих мереж;
- `true` (старе значення) = 1 хоп. "Довіряти всім" не підтримується.

Без коректного `TRUST_PROXY` за балансувальником усі запити мають один IP, і ліміт на IP стає
глобальним. У production кожен `*_SECRET` / `*_PEPPER` має бути від 32 символів і не значенням із
deny-list (`src/common/config/secret-policy.ts`).

## Тести

- Unit: `npx jest src/modules/identity` - домен (табличні тести: ліміти OTP і `resendAvailableAt`,
  блокування номера, бюджет SMS, капча, вхід адміністратора і backoff, сплески, прогрес профілю, діти,
  юридичні документи) і кожен сервіс через `createIdentityHarness()` (in-memory store, `FakeClock`,
  `InMemorySmsAdapter`, `RecordingCaptchaVerifier`; у harness пауза між кодами 0 і scrypt ln=10, окремі
  тести вмикають паузу): паралельні запити коду, IPv6 /64, обов'язковий TOTP і enrollment, одноразовий
  виклик і 5 спроб, блокування адміністратора, семафор scrypt (429), rehash, перенесення push-токена без
  розкриття іншого учасника, події полів профілю (раз на поле, паралельно), ліміт дітей, період видалення.
- Спільний шар: `src/common/logging/logging.module.spec.ts` проганяє справжній pino-http і доводить, що
  в лозі немає значень `authorization`, `cookie`, `x-validator-*`, `idempotency-key`, `set-cookie` і query;
  `secret-policy.spec.ts` розбирає `.env.example` і `docker-compose.yml` і доводить, що кожен секрет із
  них відхиляється в production; `health.controller.spec.ts` - кеш пінгу БД 5 с і ліміт `/ready` 30/хв.
- E2E: `npx jest --config test/jest-e2e.config.js test/identity` - повний AppModule з in-memory store:
  маршрути, валідація, guards, `resendAvailableAt` і пауза, `GET /legal/documents`, стать/місто/діти,
  `executeAfter`, обов'язковий TOTP owner через HTTP, блокування адміністратора, AdminGuard.
- Integration: `test/identity/identity.int-spec.ts` (`npm run test:int`, лише з `DATABASE_URL`) -
  advisory-блокування запиту коду, ключ IPv6 /64, лічильник невдач під блокуванням рядка, атомарні
  спроби TOTP-виклику, ліміт дітей і одна подія поля під паралельними запитами, а також попередні
  перевірки. Локально пропускається; потребує міграції з новими колонками (генерує інтеграція).

## Відкриті питання

1. **SMS-провайдер.** Адаптер TurboSMS написаний за публічним описом API і не перевірений на живому
   акаунті. Потрібен договір і тест на staging; альтернативи - Kyivstar/Vodafone SMS API, Viber з fallback.
2. **Капча.** Хук `CaptchaVerifierPort` є, адаптер - noop. Обрати провайдера (reCAPTCHA Enterprise /
   Cloudflare Turnstile / hCaptcha) і підключити в `IdentityModule`; застосунок має показувати капчу на
   `403 PC_OTP_CAPTCHA_REQUIRED`. Ліміт на fingerprint пристрою досі не застосовується.
3. **Ретроактивні бонуси за поля профілю.** Міграція `20261101180000_review_fixes` (розділ 3.1)
   позначає вже заповнені поля наявних учасників як оголошені (без бонусів заднім числом) - рішення
   за замовчуванням, замовник має підтвердити (`docs/INTEGRATION_NOTES.md`).
4. **Юридичні URL.** Значення `LEGAL_*_URL` за замовчуванням - заглушки на portcity.com.ua; потрібні
   справжні адреси документів і процес зміни версій (нова версія -> повторна згода в застосунку).
5. **Скидання TOTP.** Адміністратор, що втратив телефон, не може увійти (owner/manager) - потрібна
   процедура скидання TOTP власником (ендпоїнт або RUNBOOK з SQL). Шифрування `totpSecret` at rest
   (AES-256-GCM) чекає рішення щодо керування ключем.
6. **Admin-сесії.** Токен адміністратора живе 8 год без refresh; активність і роль перевіряє `AdminGuard`
   (кеш 30 с). Таблиця admin-сесій відкладена.
7. **Сесії при `DELETE /me`** лишаються до виконання запиту, щоб учасник міг скасувати видалення.
8. **Інтеграційний тест** ще не запускався на PostgreSQL (локально бази немає) - перевірити в CI після
   міграції.
