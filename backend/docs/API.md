# API PortCity backend

Згенеровано з `docs/openapi.json` (PortCity Loyalty API 0.1.0) командою `npm run docs:api`; не редагуйте файл вручну. Повний опис запитів і відповідей - Swagger UI на `/docs` або сам `docs/openapi.json`.

Усі бізнес-ендпоїнти мають префікс `/api/v1`; помилки - `application/problem+json` з кодом `PC_<MODULE>_<REASON>`. "Доступ": `учасник` - access-токен учасника, `admin: ролі` - токен адміністратора з однією з ролей (роль `owner` проходить будь-яку перевірку), `валідатор` - заголовок `X-Validator-Key` пристрою каси. Позначка в колонці Idempotency-Key означає обов’язковий заголовок `Idempotency-Key`.

Ендпоїнтів: 208.

| Розділ                                  | Тег             | Ендпоїнтів |
| --------------------------------------- | --------------- | ---------- |
| Службові (health, readiness)            | `ops`           | 2          |
| Вхід і профіль учасника (identity)      | `auth`          | 18         |
| Клубний рахунок і бали (club)           | `club`          | 4          |
| Чеки (receipts)                         | `receipts`      | 6          |
| Винагороди (rewards)                    | `rewards`       | 3          |
| Ваучери учасника (rewards)              | `vouchers`      | 5          |
| Валідатор на касі (rewards)             | `validator`     | 4          |
| Акції та події (promos)                 | `promos`        | 7          |
| Паркінг (parking)                       | `parking`       | 21         |
| Платежі (payments)                      | `payments`      | 5          |
| Сповіщення (notifications)              | `notifications` | 6          |
| Орендарі та ТРЦ (content)               | `content`       | 5          |
| Бек-офіс (/admin, токен адміністратора) | `admin`         | 119        |
| support                                 | `support`       | 3          |

## Службові (health, readiness)

Тег `ops`: Health and readiness probes.

| Метод | Шлях      | Опис                                | Доступ    | Idempotency-Key |
| ----- | --------- | ----------------------------------- | --------- | --------------- |
| GET   | `/health` | Liveness probe                      | публічний |                 |
| GET   | `/ready`  | Readiness probe: database and Redis | публічний |                 |

## Вхід і профіль учасника (identity)

Тег `auth`: OTP login, tokens, profile.

| Метод  | Шлях                       | Опис                                                                                                | Доступ    | Idempotency-Key |
| ------ | -------------------------- | --------------------------------------------------------------------------------------------------- | --------- | --------------- |
| POST   | `/api/v1/auth/logout`      | End sessions: this device (default), one login (refreshToken) or all devices                        | учасник   |                 |
| POST   | `/api/v1/auth/otp/request` | Send a 6-digit login code by SMS                                                                    | публічний |                 |
| POST   | `/api/v1/auth/otp/verify`  | Exchange the SMS code for tokens; creates the member on first login                                 | публічний |                 |
| POST   | `/api/v1/auth/refresh`     | Rotate the refresh token and get a new access token                                                 | публічний |                 |
| GET    | `/api/v1/legal/documents`  | Current consent documents: purpose, version, URL, required (public)                                 | публічний |                 |
| GET    | `/api/v1/me`               | My profile, children, profile completion, consents, pending deletion request and current device     | учасник   |                 |
| PATCH  | `/api/v1/me`               | Update name, birth date, e-mail, gender and city (null clears a field)                              | учасник   |                 |
| DELETE | `/api/v1/me`               | Request account deletion (executed after ACCOUNT_DELETION_GRACE_DAYS, default 30, unless cancelled) | учасник   |                 |
| GET    | `/api/v1/me/children`      | My children (birth month and year, gender)                                                          | учасник   |                 |
| POST   | `/api/v1/me/children`      | Add a child (at most 6)                                                                             | учасник   |                 |
| PATCH  | `/api/v1/me/children/{id}` | Change a child (birth month, year, gender)                                                          | учасник   |                 |
| DELETE | `/api/v1/me/children/{id}` | Remove a child                                                                                      | учасник   |                 |
| POST   | `/api/v1/me/consents`      | Grant or revoke consents: program, marketing, profiling                                             | учасник   |                 |
| DELETE | `/api/v1/me/deletion`      | Cancel the pending account deletion request                                                         | учасник   |                 |
| GET    | `/api/v1/me/devices`       | My devices (push tokens are never returned)                                                         | учасник   |                 |
| POST   | `/api/v1/me/devices`       | Register the push token (and app details) of the current device                                     | учасник   |                 |
| DELETE | `/api/v1/me/devices/{id}`  | Sign a device out (sessions revoked, push stopped)                                                  | учасник   |                 |
| GET    | `/api/v1/me/export`        | Download my personal data held by the identity module (JSON)                                        | учасник   |                 |

## Клубний рахунок і бали (club)

Тег `club`: Loyalty account, points, rules.

| Метод | Шлях                                | Опис                                                                          | Доступ    | Idempotency-Key |
| ----- | ----------------------------------- | ----------------------------------------------------------------------------- | --------- | --------------- |
| GET   | `/api/v1/club/account`              | My club card: balance, pending points, member code, QR payload, newcomer lock | учасник   |                 |
| GET   | `/api/v1/club/rules`                | Public program rules in force (earn rate, caps, expiry, welcome bonuses)      | публічний |                 |
| GET   | `/api/v1/club/transactions`         | My points history, newest first (cursor pagination)                           | учасник   |                 |
| GET   | `/api/v1/club/transactions/summary` | Points earned, spent and expired in a Kyiv calendar month                     | учасник   |                 |

## Чеки (receipts)

Тег `receipts`: Receipt submission and moderation.

| Метод | Шлях                                | Опис                                                                  | Доступ  | Idempotency-Key |
| ----- | ----------------------------------- | --------------------------------------------------------------------- | ------- | --------------- |
| GET   | `/api/v1/receipts`                  | My receipts, newest first (cursor pagination)                         | учасник |                 |
| POST  | `/api/v1/receipts/manual`           | Submit a receipt without a QR code (photo required, always moderated) | учасник | так             |
| POST  | `/api/v1/receipts/photo-upload-url` | Presigned PUT for a receipt photo (JPEG, PNG or HEIC, up to 5 MB)     | учасник |                 |
| POST  | `/api/v1/receipts/qr`               | Submit a fiscal receipt by its QR code                                | учасник | так             |
| GET   | `/api/v1/receipts/{id}`             | One of my receipts with points, history, appeals and photo link       | учасник |                 |
| POST  | `/api/v1/receipts/{id}/appeal`      | Appeal a rejected receipt (once); a moderator reviews it within 24 h  | учасник |                 |

## Винагороди (rewards)

Тег `rewards`: Reward catalogue and redemptions.

| Метод | Шлях                          | Опис                                                                           | Доступ            | Idempotency-Key |
| ----- | ----------------------------- | ------------------------------------------------------------------------------ | ----------------- | --------------- |
| GET   | `/api/v1/rewards`             | Reward catalogue (active rewards inside their validity period); guest-readable | гість або учасник |                 |
| GET   | `/api/v1/rewards/{id}`        | Reward detail with affordability and the per-member limit; guest-readable      | гість або учасник |                 |
| POST  | `/api/v1/rewards/{id}/redeem` | Exchange points for the reward                                                 | учасник           | так             |

## Ваучери учасника (rewards)

Тег `vouchers`: Voucher wallet: activation codes, cancellation.

| Метод | Шлях                             | Опис                                                                  | Доступ  | Idempotency-Key |
| ----- | -------------------------------- | --------------------------------------------------------------------- | ------- | --------------- |
| GET   | `/api/v1/vouchers`               | My vouchers, newest first                                             | учасник |                 |
| GET   | `/api/v1/vouchers/summary`       | Counts of my vouchers per effective status                            | учасник |                 |
| GET   | `/api/v1/vouchers/{id}`          | Voucher detail; the code is present only while the activation is live | учасник |                 |
| POST  | `/api/v1/vouchers/{id}/activate` | Activate the voucher at the counter                                   | учасник |                 |
| POST  | `/api/v1/vouchers/{id}/cancel`   | Cancel an unused voucher                                              | учасник | так             |

## Валідатор на касі (rewards)

Тег `validator`: Cashier validator devices (X-Validator-Key + shift token or PIN).

| Метод | Шлях                       | Опис                                                                               | Доступ                        | Idempotency-Key |
| ----- | -------------------------- | ---------------------------------------------------------------------------------- | ----------------------------- | --------------- |
| GET   | `/api/v1/validator/log`    | Redeem attempts of this device, newest first                                       | валідатор: ключ + токен зміни |                 |
| GET   | `/api/v1/validator/me`     | The authenticated device and the current shift                                     | валідатор: ключ + токен зміни |                 |
| POST  | `/api/v1/validator/redeem` | Redeem a voucher by code, by the scanned activation token or by a static ticket QR | валідатор: ключ + токен зміни |                 |
| POST  | `/api/v1/validator/shift`  | Open a shift with the PIN                                                          | валідатор: ключ пристрою      |                 |

## Акції та події (promos)

Тег `promos`: Promos, coupons, events.

| Метод  | Шлях                           | Опис                                                                         | Доступ            | Idempotency-Key |
| ------ | ------------------------------ | ---------------------------------------------------------------------------- | ----------------- | --------------- |
| GET    | `/api/v1/events`               | Event poster: upcoming (default) or past events (guest-readable)             | гість або учасник |                 |
| GET    | `/api/v1/events/{id}`          | Event detail with the registration and ticket of the caller (guest-readable) | гість або учасник |                 |
| POST   | `/api/v1/events/{id}/register` | Register for the event                                                       | учасник           | так             |
| DELETE | `/api/v1/events/{id}/register` | Cancel the registration                                                      | учасник           |                 |
| GET    | `/api/v1/promos`               | Published promos inside their validity window (guest-readable)               | гість або учасник |                 |
| GET    | `/api/v1/promos/{id}`          | Promo detail with the claim state of the caller (guest-readable)             | гість або учасник |                 |
| POST   | `/api/v1/promos/{id}/claim`    | Claim a coupon of the promo                                                  | учасник           | так             |

## Паркінг (parking)

Тег `parking`: Vehicles, sessions, tariff, info mode.

| Метод  | Шлях                                                | Опис                                                                                 | Доступ            | Idempotency-Key |
| ------ | --------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------- | --------------- |
| GET    | `/api/v1/parking/history`                           | My parking sessions, newest first («30.10 · 1 год 52 хв · 60 ₴»)                     | учасник           |                 |
| GET    | `/api/v1/parking/history/summary`                   | Month totals: paid, visits, time parked («Жовтень: 6 візитів · 9 год 40 хв · 340 ₴») | учасник           |                 |
| POST   | `/api/v1/parking/info/sessions`                     | I0 → I1: start the timer                                                             | учасник           |                 |
| PATCH  | `/api/v1/parking/info/sessions/{id}`                | Correct a running timer: entry time and/or zone                                      | учасник           |                 |
| DELETE | `/api/v1/parking/info/sessions/{id}`                | Discard a timer started by mistake (nothing stays in the history)                    | учасник           |                 |
| POST   | `/api/v1/parking/info/sessions/{id}/exit`           | → I4: «Я виїхав» (summary of time and approximate amount)                            | учасник           |                 |
| POST   | `/api/v1/parking/info/sessions/{id}/paid-at-paymat` | I2 → I3: «Я оплатив у паркоматі»                                                     | учасник           |                 |
| POST   | `/api/v1/parking/quote`                             | Price of a stay («Орієнтовно 60 ₴ · виїзд до 16:00»)                                 | публічний         |                 |
| GET    | `/api/v1/parking/session`                           | Current parking session for the hero card (F0-F7, I0-I4)                             | учасник           |                 |
| POST   | `/api/v1/parking/session/{id}/dispute`              | F2 «Це не моє авто» (or wrong amount, barrier)                                       | учасник           |                 |
| POST   | `/api/v1/parking/session/{id}/left`                 | «Я вже виїхав»                                                                       | учасник           |                 |
| POST   | `/api/v1/parking/session/{id}/pay`                  | Pay the amount due now                                                               | учасник           | так             |
| POST   | `/api/v1/parking/session/{id}/still-here`           | F7 «Так, я тут»                                                                      | учасник           |                 |
| POST   | `/api/v1/parking/sessions/claim`                    | Claim an operator session with its entry talon                                       | учасник           | так             |
| GET    | `/api/v1/parking/tariff`                            | Active parking tariff with ready-made Ukrainian lines                                | публічний         |                 |
| GET    | `/api/v1/parking/vehicles`                          | My vehicles, the default one first                                                   | учасник           |                 |
| POST   | `/api/v1/parking/vehicles`                          | Add a vehicle                                                                        | учасник           |                 |
| DELETE | `/api/v1/parking/vehicles/{id}`                     | Remove a vehicle (not while it is in an active session)                              | учасник           |                 |
| POST   | `/api/v1/parking/vehicles/{id}/default`             | Make the vehicle the default one («Основне»)                                         | учасник           |                 |
| POST   | `/api/v1/parking/vehicles/{id}/verify`              | Verify a vehicle with the talon or paymat code                                       | учасник           |                 |
| POST   | `/api/v1/webhooks/parking/{provider}`               | Parking operator webhook                                                             | підпис провайдера |                 |

## Платежі (payments)

Тег `payments`: Payments and provider webhooks.

| Метод | Шлях                                           | Опис                                                                              | Доступ            | Idempotency-Key |
| ----- | ---------------------------------------------- | --------------------------------------------------------------------------------- | ----------------- | --------------- |
| GET   | `/api/v1/mock-checkout/{providerRef}`          | Dev only: mock hosted checkout page                                               | публічний         |                 |
| POST  | `/api/v1/mock-checkout/{providerRef}/complete` | Dev only: finish a mock checkout and deliver the signed provider webhook          | публічний         |                 |
| GET   | `/api/v1/payments`                             | My payments, newest first (parking history, receipts of refunds)                  | учасник           |                 |
| GET   | `/api/v1/payments/{id}`                        | Payment status and receipt screen; the app polls it after returning from checkout | учасник           |                 |
| POST  | `/api/v1/webhooks/payments/{provider}`         | Payment provider webhook                                                          | підпис провайдера |                 |

## Сповіщення (notifications)

Тег `notifications`: In-app notifications and preferences.

| Метод | Шлях                                 | Опис                                                  | Доступ  | Idempotency-Key |
| ----- | ------------------------------------ | ----------------------------------------------------- | ------- | --------------- |
| GET   | `/api/v1/notifications`              | My notifications, newest first (cursor pagination)    | учасник |                 |
| GET   | `/api/v1/notifications/preferences`  | Per-kind notification preferences                     | учасник |                 |
| PUT   | `/api/v1/notifications/preferences`  | Enable or disable notification kinds (partial update) | учасник |                 |
| POST  | `/api/v1/notifications/read-all`     | Mark every notification as read                       | учасник |                 |
| GET   | `/api/v1/notifications/unread-count` | Number of unread notifications (badge)                | учасник |                 |
| POST  | `/api/v1/notifications/{id}/read`    | Mark one notification as read (idempotent)            | учасник |                 |

## Орендарі та ТРЦ (content)

Тег `content`: Tenants and mall info.

| Метод | Шлях                         | Опис                                                                                         | Доступ    | Idempotency-Key |
| ----- | ---------------------------- | -------------------------------------------------------------------------------------------- | --------- | --------------- |
| GET   | `/api/v1/mall/info`          | Mall facts: hours, address, parking hours and operator, info desk, maps, documents, contacts | публічний |                 |
| GET   | `/api/v1/tenants`            | List active tenants (cursor pagination, sorted by name)                                      | публічний |                 |
| GET   | `/api/v1/tenants/by-id/{id}` | Tenant card by id (links from vouchers, promos and receipts)                                 | публічний |                 |
| GET   | `/api/v1/tenants/categories` | Categories of active tenants with counts (filter chips)                                      | публічний |                 |
| GET   | `/api/v1/tenants/{slug}`     | Tenant card by slug                                                                          | публічний |                 |

## Бек-офіс (/admin, токен адміністратора)

Тег `admin`: Back-office endpoints (admin tokens).

### /admin/adjustments

| Метод | Шлях                                     | Опис                                                            | Доступ                             | Idempotency-Key |
| ----- | ---------------------------------------- | --------------------------------------------------------------- | ---------------------------------- | --------------- |
| GET   | `/api/v1/admin/adjustments`              | List manual adjustments, newest first                           | admin: manager, moderator, support |                 |
| POST  | `/api/v1/admin/adjustments`              | Request a manual points adjustment                              | admin: manager, support            | так             |
| GET   | `/api/v1/admin/adjustments/{id}`         | Get one manual adjustment                                       | admin: manager, moderator, support |                 |
| POST  | `/api/v1/admin/adjustments/{id}/apply`   | Retry the ledger write of an approved adjustment                | admin: manager                     | так             |
| POST  | `/api/v1/admin/adjustments/{id}/approve` | Approve a pending adjustment (second pair of eyes) and apply it | admin: manager                     | так             |
| POST  | `/api/v1/admin/adjustments/{id}/reject`  | Reject a pending or approved-but-unapplied adjustment           | admin: manager                     |                 |

### /admin/admin-users

| Метод | Шлях                             | Опис                                                             | Доступ       | Idempotency-Key |
| ----- | -------------------------------- | ---------------------------------------------------------------- | ------------ | --------------- |
| GET   | `/api/v1/admin/admin-users`      | All back-office accounts                                         | admin: owner |                 |
| POST  | `/api/v1/admin/admin-users`      | Create a back-office account (password min. 12 characters)       | admin: owner |                 |
| PATCH | `/api/v1/admin/admin-users/{id}` | Change role, name, password or activity of a back-office account | admin: owner |                 |

### /admin/audit

| Метод | Шлях                       | Опис                   | Доступ                             | Idempotency-Key |
| ----- | -------------------------- | ---------------------- | ---------------------------------- | --------------- |
| GET   | `/api/v1/admin/audit`      | Search the audit trail | admin: manager, moderator, support |                 |
| GET   | `/api/v1/admin/audit/{id}` | Get one audit entry    | admin: manager, moderator, support |                 |

### /admin/auth

| Метод | Шлях                                     | Опис                                                                                 | Доступ               | Idempotency-Key |
| ----- | ---------------------------------------- | ------------------------------------------------------------------------------------ | -------------------- | --------------- |
| POST  | `/api/v1/admin/auth/login`               | Admin login with e-mail and password (and TOTP code if enabled)                      | публічний            |                 |
| GET   | `/api/v1/admin/auth/me`                  | The admin account of the access token                                                | admin: будь-яка роль |                 |
| POST  | `/api/v1/admin/auth/totp`                | Second login step: challenge token + TOTP code -> admin access token                 | публічний            |                 |
| POST  | `/api/v1/admin/auth/totp/confirm`        | Finish enabling TOTP with the first code from the app                                | admin: будь-яка роль |                 |
| POST  | `/api/v1/admin/auth/totp/disable`        | Disable TOTP (requires a current code)                                               | admin: будь-яка роль |                 |
| POST  | `/api/v1/admin/auth/totp/enroll`         | Mandatory TOTP enrollment at login, step 1: enrollment token -> new secret           | публічний            |                 |
| POST  | `/api/v1/admin/auth/totp/enroll/confirm` | Mandatory TOTP enrollment at login, step 2: first code -> TOTP enabled + admin token | публічний            |                 |
| POST  | `/api/v1/admin/auth/totp/setup`          | Start enabling TOTP: new secret, otpauth URI and a setup token (10 minutes)          | admin: будь-яка роль |                 |

### /admin/club

| Метод  | Шлях                                                | Опис                                                                    | Доступ                                    | Idempotency-Key |
| ------ | --------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------- | --------------- |
| GET    | `/api/v1/admin/club/accounts/{userId}`              | Member loyalty account: balances, newcomer lock, welcome flags, buckets | admin: owner, manager, support, moderator |                 |
| GET    | `/api/v1/admin/club/accounts/{userId}/transactions` | Member points ledger with idempotency keys, newest first                | admin: owner, manager, support, moderator |                 |
| GET    | `/api/v1/admin/club/rule-sets`                      | All rule set versions, newest first; `active` marks the one in force    | admin: owner, manager, support, moderator |                 |
| POST   | `/api/v1/admin/club/rule-sets`                      | Create a new rule set version                                           | admin: owner, manager                     |                 |
| GET    | `/api/v1/admin/club/rule-sets/{id}`                 | One rule set version                                                    | admin: owner, manager, support, moderator |                 |
| PATCH  | `/api/v1/admin/club/rule-sets/{id}`                 | Edit a version that is scheduled for the future                         | admin: owner, manager                     |                 |
| DELETE | `/api/v1/admin/club/rule-sets/{id}`                 | Delete a version that is scheduled for the future                       | admin: owner, manager                     |                 |

### /admin/content

| Метод | Шлях                                     | Опис                                                                                      | Доступ                             | Idempotency-Key |
| ----- | ---------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------- | --------------- |
| POST  | `/api/v1/admin/content/import`           | Run the WordPress import stub (dryRun computes the plan without writing; async queues it) | admin: manager                     |                 |
| GET   | `/api/v1/admin/content/import-runs`      | Import runs, newest first                                                                 | admin: manager, moderator, support |                 |
| GET   | `/api/v1/admin/content/import-runs/{id}` | Import run detail with stats                                                              | admin: manager, moderator, support |                 |
| GET   | `/api/v1/admin/content/mall-info`        | Stored mall facts (null = configuration) and the effective answer                         | admin: manager, moderator, support |                 |
| PUT   | `/api/v1/admin/content/mall-info`        | Replace the mall facts (PUT semantics: omitted fields fall back to configuration)         | admin: manager                     |                 |

### /admin/coupon-templates

| Метод  | Шлях                                  | Опис                                                   | Доступ                             | Idempotency-Key |
| ------ | ------------------------------------- | ------------------------------------------------------ | ---------------------------------- | --------------- |
| GET    | `/api/v1/admin/coupon-templates`      | List coupon templates                                  | admin: manager, support, moderator |                 |
| POST   | `/api/v1/admin/coupon-templates`      | Create a coupon template                               | admin: manager                     |                 |
| GET    | `/api/v1/admin/coupon-templates/{id}` | Coupon template detail                                 | admin: manager, support, moderator |                 |
| PATCH  | `/api/v1/admin/coupon-templates/{id}` | Update a coupon template                               | admin: manager                     |                 |
| DELETE | `/api/v1/admin/coupon-templates/{id}` | Delete a coupon template that is not linked to a promo | admin: manager                     |                 |

### /admin/events

| Метод  | Шлях                                                              | Опис                                                                | Доступ                             | Idempotency-Key |
| ------ | ----------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------- | --------------- |
| GET    | `/api/v1/admin/events`                                            | List events (any status)                                            | admin: manager, support, moderator |                 |
| POST   | `/api/v1/admin/events`                                            | Create a draft event                                                | admin: manager                     |                 |
| GET    | `/api/v1/admin/events/{id}`                                       | Event detail                                                        | admin: manager, support, moderator |                 |
| PATCH  | `/api/v1/admin/events/{id}`                                       | Update event fields (capacity cannot drop below registered persons) | admin: manager                     |                 |
| DELETE | `/api/v1/admin/events/{id}`                                       | Delete a draft event                                                | admin: manager                     |                 |
| POST   | `/api/v1/admin/events/{id}/cancel`                                | Cancel the event                                                    | admin: manager                     |                 |
| POST   | `/api/v1/admin/events/{id}/finish`                                | Mark a published event as finished (the hourly job does it too)     | admin: manager                     |                 |
| POST   | `/api/v1/admin/events/{id}/publish`                               | Publish a draft event                                               | admin: manager                     |                 |
| GET    | `/api/v1/admin/events/{id}/registrations`                         | Registrations of the event                                          | admin: manager, support, moderator |                 |
| POST   | `/api/v1/admin/events/{id}/registrations/{registrationId}/cancel` | Cancel one registration (ticket cancelled, seats released)          | admin: manager                     |                 |

### /admin/feature-flags

| Метод  | Шлях                                | Опис                                                        | Доступ                             | Idempotency-Key |
| ------ | ----------------------------------- | ----------------------------------------------------------- | ---------------------------------- | --------------- |
| GET    | `/api/v1/admin/feature-flags`       | List feature flags                                          | admin: manager, moderator, support |                 |
| GET    | `/api/v1/admin/feature-flags/{key}` | Get one feature flag                                        | admin: manager, moderator, support |                 |
| PUT    | `/api/v1/admin/feature-flags/{key}` | Create or update a feature flag                             | admin: manager                     |                 |
| DELETE | `/api/v1/admin/feature-flags/{key}` | Delete a feature flag (readers fall back to their defaults) | admin: manager                     |                 |

### /admin/fiscal-numbers

| Метод  | Шлях                                        | Опис                                                              | Доступ                             | Idempotency-Key |
| ------ | ------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------- | --------------- |
| GET    | `/api/v1/admin/fiscal-numbers`              | List fiscal numbers, newest first                                 | admin: manager, moderator, support |                 |
| POST   | `/api/v1/admin/fiscal-numbers`              | Register a fiscal number (source admin)                           | admin: manager, moderator          |                 |
| GET    | `/api/v1/admin/fiscal-numbers/{id}`         | Fiscal number detail                                              | admin: manager, moderator, support |                 |
| PATCH  | `/api/v1/admin/fiscal-numbers/{id}`         | Change mapping, note or status (state machine applies)            | admin: manager, moderator          |                 |
| DELETE | `/api/v1/admin/fiscal-numbers/{id}`         | Delete a pending or blocked number (block an active one instead)  | admin: manager, moderator          |                 |
| POST   | `/api/v1/admin/fiscal-numbers/{id}/block`   | Block a number (receipts from it go to moderation)                | admin: manager, moderator          |                 |
| POST   | `/api/v1/admin/fiscal-numbers/{id}/confirm` | Confirm a pending (or blocked) number: active, mapped to a tenant | admin: manager, moderator          |                 |

### /admin/notifications

| Метод | Шлях                               | Опис                                      | Доступ                             | Idempotency-Key |
| ----- | ---------------------------------- | ----------------------------------------- | ---------------------------------- | --------------- |
| GET   | `/api/v1/admin/notifications`      | A member's notifications, newest first    | admin: manager, support, moderator |                 |
| POST  | `/api/v1/admin/notifications`      | Send a notification to a member (audited) | admin: manager, support            |                 |
| GET   | `/api/v1/admin/notifications/{id}` | One notification with its push deliveries | admin: manager, support, moderator |                 |

### /admin/parking

| Метод | Шлях                                             | Опис                                                                         | Доступ                  | Idempotency-Key |
| ----- | ------------------------------------------------ | ---------------------------------------------------------------------------- | ----------------------- | --------------- |
| GET   | `/api/v1/admin/parking/sessions`                 | Parking sessions, newest first                                               | admin: manager, support |                 |
| POST  | `/api/v1/admin/parking/sessions/{id}/close-free` | Close a session free of charge (closed_free: privilege or air raid; audited) | admin: manager, support |                 |
| GET   | `/api/v1/admin/parking/tariffs`                  | Tariff versions, newest activeFrom first                                     | admin: manager          |                 |
| POST  | `/api/v1/admin/parking/tariffs`                  | Create the next tariff version (versions are never edited; audited)          | admin: manager          |                 |
| GET   | `/api/v1/admin/parking/tariffs/{version}`        | One tariff version                                                           | admin: manager          |                 |

### /admin/payments

| Метод | Шлях                                    | Опис                                                             | Доступ                         | Idempotency-Key |
| ----- | --------------------------------------- | ---------------------------------------------------------------- | ------------------------------ | --------------- |
| GET   | `/api/v1/admin/payments`                | Payments across members with filters (newest first)              | admin: owner, manager, support |                 |
| GET   | `/api/v1/admin/payments/{id}`           | Payment with bookkeeping and the provider webhook log            | admin: owner, manager, support |                 |
| POST  | `/api/v1/admin/payments/{id}/reconcile` | Ask the provider for the current status of an open payment now   | admin: owner, manager, support |                 |
| POST  | `/api/v1/admin/payments/{id}/refund`    | Refund a captured payment (full or partial) through the provider | admin: owner, manager          | так             |

### /admin/promos

| Метод  | Шлях                                | Опис                                                             | Доступ                             | Idempotency-Key |
| ------ | ----------------------------------- | ---------------------------------------------------------------- | ---------------------------------- | --------------- |
| GET    | `/api/v1/admin/promos`              | List promos (any status)                                         | admin: manager, support, moderator |                 |
| POST   | `/api/v1/admin/promos`              | Create a draft promo (optionally with an inline coupon template) | admin: manager                     |                 |
| GET    | `/api/v1/admin/promos/{id}`         | Promo detail                                                     | admin: manager, support, moderator |                 |
| PATCH  | `/api/v1/admin/promos/{id}`         | Update promo fields                                              | admin: manager                     |                 |
| DELETE | `/api/v1/admin/promos/{id}`         | Delete a draft promo                                             | admin: manager                     |                 |
| POST   | `/api/v1/admin/promos/{id}/archive` | Archive a promo (final)                                          | admin: manager                     |                 |
| POST   | `/api/v1/admin/promos/{id}/publish` | Publish a draft promo (emits promo.published)                    | admin: manager                     |                 |

### /admin/receipts

| Метод | Шлях                                  | Опис                                                                            | Доступ                             | Idempotency-Key |
| ----- | ------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------- | --------------- |
| GET   | `/api/v1/admin/receipts`              | Receipts by status (moderation queue: needs_moderation, appealed; oldest first) | admin: moderator, manager, support |                 |
| GET   | `/api/v1/admin/receipts/{id}`         | Receipt with risk flags, history, appeals and a signed photo URL (audited view) | admin: moderator, manager, support |                 |
| POST  | `/api/v1/admin/receipts/{id}/approve` | Approve a receipt in moderation and credit its points                           | admin: moderator, manager          | так             |
| POST  | `/api/v1/admin/receipts/{id}/reject`  | Reject a receipt in moderation with a reason shown to the member                | admin: moderator, manager          |                 |

### /admin/reports

| Метод | Шлях                                    | Опис                                                                                  | Доступ                             | Idempotency-Key |
| ----- | --------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------- | --------------- |
| GET   | `/api/v1/admin/reports/daily`           | Daily report: receipts by status, points earned/spent, vouchers, parking, adjustments | admin: manager, moderator, support |                 |
| GET   | `/api/v1/admin/reports/daily/range`     | Stored daily reports for a range of days (inclusive, max 92 days)                     | admin: manager, moderator, support |                 |
| POST  | `/api/v1/admin/reports/daily/recompute` | Recompute and store the daily report for a day (default yesterday)                    | admin: manager                     |                 |

### /admin/rewards

| Метод  | Шлях                         | Опис                                                          | Доступ                | Idempotency-Key |
| ------ | ---------------------------- | ------------------------------------------------------------- | --------------------- | --------------- |
| GET    | `/api/v1/admin/rewards`      | All rewards (any status), ordered by sortOrder                | admin: owner, manager |                 |
| POST   | `/api/v1/admin/rewards`      | Create a reward                                               | admin: owner, manager |                 |
| GET    | `/api/v1/admin/rewards/{id}` | Reward detail                                                 | admin: owner, manager |                 |
| PATCH  | `/api/v1/admin/rewards/{id}` | Update a reward (only the fields sent)                        | admin: owner, manager |                 |
| DELETE | `/api/v1/admin/rewards/{id}` | Deactivate a reward (soft delete; issued vouchers stay valid) | admin: owner, manager |                 |

### /admin/support-requests

| Метод | Шлях                                  | Опис                                              | Доступ                  | Idempotency-Key |
| ----- | ------------------------------------- | ------------------------------------------------- | ----------------------- | --------------- |
| GET   | `/api/v1/admin/support-requests`      | Support requests, newest first (?status=&userId=) | admin: manager, support |                 |
| GET   | `/api/v1/admin/support-requests/{id}` | One support request with a short-lived photo link | admin: manager, support |                 |
| PATCH | `/api/v1/admin/support-requests/{id}` | Change the status and/or add a note (audited)     | admin: manager, support |                 |

### /admin/tenant-rules

| Метод  | Шлях                              | Опис                                                           | Доступ                             | Idempotency-Key |
| ------ | --------------------------------- | -------------------------------------------------------------- | ---------------------------------- | --------------- |
| GET    | `/api/v1/admin/tenant-rules`      | List tenant rules, newest first (filter by tenantId, activeAt) | admin: manager, moderator, support |                 |
| POST   | `/api/v1/admin/tenant-rules`      | Create a rule for a tenant                                     | admin: manager                     |                 |
| GET    | `/api/v1/admin/tenant-rules/{id}` | Rule detail                                                    | admin: manager, moderator, support |                 |
| PATCH  | `/api/v1/admin/tenant-rules/{id}` | Update rate, minimum, cap or period (overlap is rejected)      | admin: manager                     |                 |
| DELETE | `/api/v1/admin/tenant-rules/{id}` | Delete a rule                                                  | admin: manager                     |                 |

### /admin/tenants

| Метод  | Шлях                                        | Опис                                                              | Доступ                             | Idempotency-Key |
| ------ | ------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------- | --------------- |
| GET    | `/api/v1/admin/tenants`                     | List tenants (any status unless filtered), sorted by name         | admin: manager, moderator, support |                 |
| POST   | `/api/v1/admin/tenants`                     | Create a tenant (slug derived from the name when omitted)         | admin: manager                     |                 |
| GET    | `/api/v1/admin/tenants/{id}`                | Tenant detail (any status)                                        | admin: manager, moderator, support |                 |
| PATCH  | `/api/v1/admin/tenants/{id}`                | Update tenant fields                                              | admin: manager                     |                 |
| DELETE | `/api/v1/admin/tenants/{id}`                | Close a tenant (soft delete)                                      | admin: manager                     |                 |
| GET    | `/api/v1/admin/tenants/{id}/effective-rule` | Loyalty rule that applies to the tenant at a moment (default now) | admin: manager, moderator, support |                 |

### /admin/users

| Метод | Шлях                                       | Опис                                                                | Доступ                                    | Idempotency-Key |
| ----- | ------------------------------------------ | ------------------------------------------------------------------- | ----------------------------------------- | --------------- |
| GET   | `/api/v1/admin/users`                      | Search members by phone (any notation), member code, e-mail or name | admin: owner, manager, support, moderator |                 |
| GET   | `/api/v1/admin/users/{id}`                 | Member card: profile (masked phone), devices, consents, sessions    | admin: owner, manager, support, moderator |                 |
| POST  | `/api/v1/admin/users/{id}/block`           | Block a member (sessions revoked, user.blocked published)           | admin: owner, manager                     |                 |
| POST  | `/api/v1/admin/users/{id}/revoke-sessions` | Log the member out on every device (lost phone, takeover)           | admin: owner, manager, support            |                 |
| POST  | `/api/v1/admin/users/{id}/unblock`         | Unblock a member                                                    | admin: owner, manager                     |                 |

### /admin/validator-devices

| Метод | Шлях                                              | Опис                                                                             | Доступ                | Idempotency-Key |
| ----- | ------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------- | --------------- |
| GET   | `/api/v1/admin/validator-devices`                 | Validator devices, newest first                                                  | admin: owner, manager |                 |
| POST  | `/api/v1/admin/validator-devices`                 | Register a validator device                                                      | admin: owner, manager |                 |
| GET   | `/api/v1/admin/validator-devices/{id}`            | Validator device detail                                                          | admin: owner, manager |                 |
| PATCH | `/api/v1/admin/validator-devices/{id}`            | Rename, re-assign or re-activate a device                                        | admin: owner, manager |                 |
| GET   | `/api/v1/admin/validator-devices/{id}/log`        | Redeem attempts of the device, newest first                                      | admin: owner, manager |                 |
| POST  | `/api/v1/admin/validator-devices/{id}/pin`        | Set a new shift PIN (6-12 digits); open shifts are closed, a PIN lock is cleared | admin: owner, manager |                 |
| POST  | `/api/v1/admin/validator-devices/{id}/revoke`     | Revoke a device remotely; it stops authenticating immediately                    | admin: owner, manager |                 |
| POST  | `/api/v1/admin/validator-devices/{id}/rotate-key` | Issue a new device key (shown once); the old key stops working                   | admin: owner, manager |                 |

### /admin/vouchers

| Метод | Шлях                                 | Опис                                                                  | Доступ                         | Idempotency-Key |
| ----- | ------------------------------------ | --------------------------------------------------------------------- | ------------------------------ | --------------- |
| GET   | `/api/v1/admin/vouchers`             | Vouchers across members with filters, newest first (effective status) | admin: owner, manager, support |                 |
| POST  | `/api/v1/admin/vouchers`             | Issue a voucher to a member on behalf of the mall (sourceType admin)  | admin: owner, manager          | так             |
| GET   | `/api/v1/admin/vouchers/{id}`        | Voucher detail                                                        | admin: owner, manager, support |                 |
| POST  | `/api/v1/admin/vouchers/{id}/cancel` | Cancel a live voucher                                                 | admin: owner, manager          | так             |

## support

| Метод | Шлях                                        | Опис                              | Доступ  | Idempotency-Key |
| ----- | ------------------------------------------- | --------------------------------- | ------- | --------------- |
| GET   | `/api/v1/support/requests`                  | My support requests, newest first | учасник |                 |
| POST  | `/api/v1/support/requests`                  | Send a support request            | учасник | так             |
| POST  | `/api/v1/support/requests/photo-upload-url` | Presigned PUT for a support photo | учасник |                 |
