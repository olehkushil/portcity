> **Застосовано (архів).** Внесено в `prisma/seed.ts` інтеграцією 01.11.2026 (схема - міграцією
> `20261101180000_review_fixes`): адміністратор створюється один раз із хешем `PASSWORD_SCRYPT_PARAMS`
> (ln=17, ключ 64 байти) і більше не змінюється; наприкінці seed друкує нагадування про TOTP;
> `SEED_ADMIN_TOTP_SECRET` - лише для dev-стенда (у production seed його відхиляє); демо-учасник має
> `gender`, `city`, дитину й усі `completed_profile_fields`; версія згод `2026-10`.

# identity: зміни для `prisma/seed.ts` (не внесені, файл належить інтеграції)

Контекст: виправлення рецензії безпеки й профілю (2026-11-01). Seed пише в БД напряму (без сервісів),
тому події outbox не публікуються - нові поля треба заповнити узгоджено.

## 1. Адміністратор `admin@portcity.local` (роль owner)

- **Обов'язковий TOTP.** Ролі з `ADMIN_REQUIRE_TOTP_ROLES` (типово `owner,manager`) без TOTP більше
  не входять паролем: `POST /admin/auth/login` відповідає `403 PC_ADMIN_TOTP_SETUP_REQUIRED` з
  `details.enrollmentToken`, далі `POST /admin/auth/totp/enroll` -> `POST /admin/auth/totp/enroll/confirm`
  (перший код з автентифікатора) -> токен. Запропоновано:
  - надрукувати в кінці seed попередження: «owner має налаштувати TOTP під час першого входу»;
  - опційно `SEED_ADMIN_TOTP_SECRET` (base32, лише seed): якщо задано, записати його в `totp_secret`,
    щоб демо-стенд мав відомий секрет (і додати змінну до `SEED_ONLY_KEYS` у
    `src/common/config/env-example.spec.ts` та в `.env.example`). Для локальної розробки без
    автентифікатора альтернатива - `ADMIN_REQUIRE_TOTP_ROLES=none` у `.env` (не в production).
- **Вартість scrypt.** Новий пароль адміністратора хешується з `PASSWORD_SCRYPT_PARAMS`
  (`src/common/auth/crypto.ts`, N = 2^17, ключ 64 байти). Seed зараз пише `ln=14`, ключ 32 байти:
  такий хеш працює, але оновлюється до `ln=17` при першому успішному вході (`needsRehash`). Бажано
  одразу писати `ln=17,r=8,p=1` з 64-байтним ключем (`scryptSync(password, salt, 64,
{ N: 131072, r: 8, p: 1, maxmem: 256 * 131072 * 8 })`).
- Нові колонки `admin_users` мають значення за замовчуванням (`failed_login_count = 0`,
  `login_challenge_attempts = 0`, решта `NULL`) - у seed нічого не треба.
- Пароль за замовчуванням `ChangeMe-2026!` у production відхиляється (`SEED_ADMIN_PASSWORD` є в
  deny-list секретів: містить `changeme`).

## 2. Демо-учасник `+380501234567` (Олег, 734211800)

Опційно, щоб екран профілю й `profileCompletion` мали дані:

- `gender = 'male'`, `city = 'Луцьк'`;
- одна дитина в `children`: `{ id: uuidv7(), user_id, birth_month: 5, birth_year: 2019, gender: 'female' }`
  (ідемпотентно: upsert за фіксованим id);
- `completed_profile_fields` = масив полів, які seed заповнює (наприклад
  `{firstName,lastName,birthDate,gender,city,children}`), інакше перший `PATCH /me` після seed
  оголосить їх усі (`user.profile_field_completed`) і club нарахує бонуси за поля, яких учасник не
  заповнював у застосунку.

## 3. Згоди

Версії текстів тепер у конфігурації (`LEGAL_PROGRAM_VERSION` та ін., типово `2026-10`). Якщо seed
створює згоди демо-учасника, версія має збігатися з `LEGAL_*_VERSION` (зараз `2026-10`).

## 4. Статичний OTP-код демо-номера

`OTP_STATIC_CODES=+380501234567:123456` у docker-compose працює лише в development. У production
потрібні `ALLOW_STATIC_OTP=true` і 8-значні коди (`+380501234567:12345678`).
