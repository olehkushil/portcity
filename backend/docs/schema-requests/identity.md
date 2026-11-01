# Запити модуля identity на зміни схеми

Автор: identity-агент, 2026-11-01. Файл схеми `prisma/schema/identity.prisma` належить identity, але
міграції застосовує schema/integration-агент, тому зміни оформлено як запит. Модуль працює з поточною
схемою; пункти нижче - покращення безпеки, не блокери.

## 1. Захист від повторного використання TOTP-коду

- Файл і модель: `prisma/schema/identity.prisma`, `AdminUser`.
- Фрагмент:

  ```prisma
  /// Last accepted TOTP time step (unix seconds / 30); a code of this or an earlier step is refused.
  totpLastStep Int? @map("totp_last_step")
  ```

- Причина: зараз код TOTP можна використати повторно в межах його 30-секундного вікна (плюс допуск
  `ADMIN_TOTP_TOLERANCE_SECONDS`), бо ніде не зберігається останній прийнятий крок. З полем сервіс
  `AdminAuthService` прийматиме лише крок, більший за збережений (атомарний `updateMany ... WHERE
totp_last_step IS NULL OR totp_last_step < :step`).
- Вплив на міграцію: нова nullable-колонка, без заповнення даних, сумісна.

## 2. (Опційно) Сесії адміністраторів

- Файл і модель: `prisma/schema/identity.prisma`, нова модель `AdminSession` (id, adminId, family,
  tokenHash unique, expiresAt, revokedAt, replacedById, createdAt, ip, userAgent) за зразком
  `RefreshToken`.
- Причина: дозволить скоротити TTL admin access-токена з 8 год до 15 хв із ротацією refresh-токенів і
  миттєвим відкликанням при деактивації (див. `docs/contract-requests/identity.md`, пункт 3).
- Вплив на міграцію: нова таблиця, сумісна.

## 3. (Опційно) Шифрування `AdminUser.totpSecret` at rest

- Не зміна схеми, а зміна формату значення: зберігати `v1:<iv>:<ciphertext>:<tag>` (AES-256-GCM, ключ
  `TOTP_ENCRYPTION_KEY` з env). Потребує рішення щодо керування ключем (план 7.4: шифрування at rest).
  До рішення секрет зберігається у відкритому вигляді, як і в seed.

## Рішення integration (2026-11-01)

- Пункт 1 (`totpLastStep`): застосовано - колонка `admin_users.totp_last_step`, `AdminAuthService` атомарно займає крок (`claimTotpStep`), повтор коду відхиляється `PC_ADMIN_TOTP_INVALID`.
- Пункт 2 (`AdminSession`): відхилено - замість короткого токена з ротацією спільний `AdminGuard` перевіряє активність і роль адміністратора (`IdentityPort.getAdminAccess`, кеш 30 с).
- Пункт 3 (шифрування `totpSecret`): відкладено до рішення щодо керування ключем (відкрите питання).
