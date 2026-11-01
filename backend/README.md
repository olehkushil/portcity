# PortCity Loyalty Backend

Бекенд мобільного застосунку ТРЦ «Порт City» (Луцьк, просп. Соборності, 43): програма лояльності, чеки,
винагороди, акції та події, паркінг, платежі, сповіщення, бек-офіс. NestJS 12, TypeScript, Prisma 6
(PostgreSQL 17), BullMQ 6 (Redis 7). Вимоги: `docs/BRIEF.md`.

## Швидкий старт

1. Встановіть Node 24 (`.nvmrc`) і Docker.
2. `cp .env.example .env` - коментарі українською, значення безпечні для розробки.
3. `npm ci && npm run db:generate` - залежності, потім Prisma-клієнт. npm 11 не запускає install-скрипти
   залежностей без дозволу (`allowScripts`), тому клієнт генерується окремою командою, як у CI і Dockerfile.
4. `docker compose up -d postgres redis` - PostgreSQL і Redis локально.
5. `npm run db:deploy` - міграції (`init`, `module_requests`, `review_fixes`; після третьої на базі з даними -
   звіт канонічних номерів чеків, `docs/RUNBOOK.md` розділ 4.1).
6. `npm run db:seed` - демо-дані: орендарі, винагороди, учасник `+380501234567`, адміністратор `admin@portcity.local`
   (owner налаштовує TOTP під час першого входу, `docs/RUNBOOK.md` розділ 5.1; у production seed вимагає
   власні `SEED_ADMIN_PASSWORD`, `SEED_VALIDATOR_KEY`, `SEED_VALIDATOR_PIN`).
7. `npm run start:dev` - API на http://localhost:3000/api/v1, Swagger на http://localhost:3000/docs.
8. `npm run start:worker:dev` - воркер черг в окремому терміналі (outbox, розклади; потребує Redis).
9. `npm run test:all` - юніт- та e2e-тести без зовнішніх сервісів (`npm test` додає інтеграційні з `DATABASE_URL`).
10. `npm run lint && npm run typecheck && npm run build` - перевірки перед комітом (так само робить CI).

Повний стек у Docker (API, воркер, БД, Redis): `docker compose up --build`; демо-сценарій паркінгу,
міграції, seed, ротація секретів і моніторинг - `docs/RUNBOOK.md`.

Jest і ESM: NestJS 12 постачається як ESM, тому Jest потребує `--experimental-vm-modules`; `.npmrc`
(`node-options`) додає прапорець до всіх npm-скриптів і `npx`. Поза npm виставте
`NODE_OPTIONS=--experimental-vm-modules`.

## Модулі

| Модуль          | Що робить                                                                                                                               |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `identity`      | вхід за SMS-кодом, сесії з ротацією refresh-токенів, профіль з дітьми, згоди, пристрої, видалення акаунта, бек-офіс з обов'язковим TOTP |
| `club`          | клубні рахунки, append-only леджер балів, FIFO-згоряння, утримання, вітальні бонуси й бонуси за поля профілю, набори правил             |
| `content`       | орендарі з годинами роботи, білий список фіскальних номерів, правила орендарів, `GET /mall/info`, імпорт WordPress                      |
| `receipts`      | QR податкової і ручні чеки з фото, канонічні номери, правила ризику й утримання на перевірку, модерація, оскарження                     |
| `rewards`       | каталог винагород, обмін балів, ваучери з кодом на 2 хв і статичним QR квитків, валідатори на касах                                     |
| `promos`        | акції й купони (`coupon_claims`) з категоріями, події (категорії, вік, зовнішній вхід) та реєстрації з квитками                         |
| `parking`       | авто, сесії оператора (емулятор у розробці) й інфо-режим, тариф, оплата з автоповерненням, спори, нагадування, тривога                  |
| `payments`      | платежі через порт провайдера (мок), спроби, підписані вебхуки, повернення, квитанція, фіскалізація, звіряння                           |
| `notifications` | скринька, налаштування, push (stub / FCM), пошта підтримці, сповіщення з подій outbox, маркетинг за згодою                              |
| `admin`         | ручні коригування балів («чотири очі»), аудит, feature flags, щоденні звіти, звернення в підтримку                                      |

Кожен модуль має власний `README.md` у `src/modules/<name>/` (модель, стан-машини, ендпоїнти, задачі,
змінні середовища, відкриті питання).

## Команди

| Команда                                                                 | Призначення                                           |
| ----------------------------------------------------------------------- | ----------------------------------------------------- |
| `npm run start:dev` / `npm run start:worker:dev`                        | API / воркер з перезавантаженням                      |
| `npm run build`, `npm start`, `npm run start:worker`                    | збірка в `dist/` і запуск                             |
| `npm run lint`, `npm run typecheck`, `npm run format`                   | ESLint 9 + Prettier, `tsc --noEmit` для всього дерева |
| `npm run test:unit`, `test:e2e`, `test:int`, `test:all`, `test`         | тести (int самопропускаються без `DATABASE_URL`)      |
| `npm run db:deploy`, `db:migrate`, `db:seed`, `db:reset`, `db:validate` | Prisma: міграції, seed, валідація                     |
| `npm run openapi`, `npm run docs:api`                                   | `docs/openapi.json` без БД; `docs/API.md` з нього     |

## Документація

- `docs/ARCHITECTURE.md` - карта модулів, порти, каталог подій outbox, черги й розклади, потоки даних.
- `docs/API.md` - таблиця ендпоїнтів за тегами (генерується `npm run docs:api`), Swagger - `/docs`.
- `docs/RUNBOOK.md` - запуск з Docker і без, міграції, seed, демо паркінгу, секрети, модерація, моніторинг.
- `docs/INTEGRATION_NOTES.md` - рішення, відхилення від BRIEF, запити модулів, відомі прогалини, питання до замовника.
- `docs/BRIEF.md` - обов'язкові вимоги; `docs/FOUNDATION_SUMMARY.md` - інструкція для розробників модулів (англійською).

English summary: NestJS 12 modular monolith (API + BullMQ worker) for the Порт City mall app; quick start
above, architecture in `docs/ARCHITECTURE.md`, endpoints in `docs/API.md`, operations in `docs/RUNBOOK.md`.
