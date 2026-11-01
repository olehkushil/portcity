# Запити модуля club до схеми

## club-1: окреме місце для позначок нагадувань про згоряння

- Файл і модель: `prisma/schema/club.prisma`, `PointsExpiryBucket` (варіант А, рекомендовано) або
  `LoyaltyAccount` (варіант Б).
- Пропонований фрагмент:

  ```prisma
  // Варіант А: на кошику (позначка зникає разом із кошиком після згоряння)
  model PointsExpiryBucket {
    // ... наявні поля
    /// Пороги (днів до згоряння), для яких уже опубліковано points.expiring.
    remindedDays Int[] @default([]) @map("reminded_days")
  }

  // Варіант Б: службове jsonb на рахунку
  model LoyaltyAccount {
    // ... наявні поля
    meta Json @default("{}")
  }
  ```

- Причина: щоденна задача `points-expire` публікує `points.expiring` за 30 і 7 днів (BRIEF розділ 9),
  а notifications дедуплікує лише за id події outbox. Щоб повторний запуск задачі (retry BullMQ,
  ручний перезапуск) не надсилав нагадування вдруге, club запам'ятовує надіслані пороги. Зараз
  позначки лежать у власному jsonb `loyalty_accounts.welcome_state` під ключем `expiryReminders`
  (`{"2026-12-01": [30]}`, минулі дні вичищаються), що змішує їх із прапорцями вітальних бонусів.
- Вплив на міграцію: лише додавання колонки з default, заповнення не потрібне (старі позначки в
  `welcome_state` можна проігнорувати: у гіршому разі одне повторне нагадування в день міграції).
  Код: зміна в одному місці - `parseExpiryReminderState`/`accountStateJson` у
  `src/modules/club/domain/reminders.ts` і `updateAccount` у `prisma-club.repository.ts`.
- Статус: застосовано 2026-11-01 (integration) у зміненому вигляді: окрема колонка `loyalty_accounts.expiry_reminders` (jsonb, той самий формат `{"2026-12-01": [30, 7]}`) замість загального `meta`; міграція переносить позначки з `welcome_state.expiryReminders`. Варіант А (на кошику) не взяли: домен уже зберігає позначки на рахунку.

## club-2: частковий індекс для зняття утримань

- Файл і модель: `prisma/schema/migrations/<init>/migration.sql` (Prisma не описує часткові індекси).
- Пропонований фрагмент:

  ```sql
  CREATE INDEX "points_transactions_pending_available_at_idx"
    ON "points_transactions" ("available_at")
    WHERE "state" = 'pending';
  ```

- Причина: щогодинна задача `points-release-holds` вибирає `state = 'pending' AND available_at <= now()`
  у порядку `available_at`; наявний індекс `(state, expires_at)` не покриває сортування за
  `available_at`. Утримань мало (лише чеки понад 3 000 грн), тож це оптимізація, не блокер.
- Вплив на міграцію: лише створення індексу.
- Статус: застосовано 2026-11-01 (integration): `points_transactions_pending_available_at_idx` у міграції `20261101120000_module_requests` (init-міграцію не змінювали).

## club-3: день кошика в seed - за київським часом

- Файл: `prisma/seed.ts`, функція `seedDemoActivity` (блок "FIFO expiry buckets").
- Пропонована зміна: ключ кошика рахувати як київський календарний день `expiresAt`
  (`kyivDayKey(addMonths(...))` з `src/common/time/kyiv.ts` і `dayKeyToDate` з
  `src/modules/club/domain/expiry.ts`), а не `utcDateOnly(...)`; `expiresAt` рядків - через
  `computeExpiresAt` (місяці в київському часі), як це робить леджер.
- Причина: леджер кладе бали в кошик київського дня `expiresAt`, а при згорянні шукає нарахування
  дня в межах `[00:00, 24:00)` за Києвом. Для демо-рядків, створених між 22:00 і 24:00 UTC, дні
  розходяться: суми та інваріант не страждають, але такі нарахування не позначаться `expired`/`spent`
  при згорянні їхнього кошика.
- Вплив: лише seed, міграції немає.
- Статус: застосовано 2026-11-01 (integration): seed рахує `expiresAt` через `computeExpiresAt` і день кошика через `bucketDayKey` з `src/modules/club/domain/expiry.ts`.

English summary: (1) a dedicated column for expiry-reminder markers (now stored under
`welcome_state.expiryReminders`); (2) a partial index on pending holds by `available_at`;
(3) make the seed compute bucket days in Kyiv time like the ledger does.
