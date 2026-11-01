# Запити модуля receipts до схеми

## receipts-1: структуровані причини рішення на `Receipt`

- Файл і модель: `prisma/schema/receipts.prisma`, `Receipt` (таблиця `receipts`).
- Пропонований фрагмент:

  ```prisma
  /// Why the rules sent the receipt to moderation: manual_submission, fn_not_whitelisted, fn_blocked,
  /// total_above_threshold, daily_limit_reached, same_fn_burst.
  moderationReasons Json    @default("[]") @map("moderation_reasons")
  /// Rule that rejected the receipt (PC_RECEIPT_TOO_OLD, ...); null for moderator rejections.
  rejectionCode     String? @map("rejection_code") @db.VarChar(64)
  ```

- Причина: екран «Чек на перевірці» показує «Причина перевірки», а відхилений чек — код правила
  (BRIEF розділ 7). Зараз ці дані живуть лише в `ReceiptEvent.note` (`moderation: a, b`,
  `PC_RECEIPT_TOO_OLD: ...`) і розбираються функціями `parseModerationNote`/`parseRejectionNote`
  (`src/modules/receipts/domain/submission-view.ts`). Колонки дадуть фільтрацію черги модерації за
  причиною і приберуть залежність від формату нотаток.
- Вплив на міграцію: дві нові колонки з типовими значеннями, заповнення не обов'язкове (старі
  рядки читаються з нотаток, код уже це вміє). Сумісність не ламається.
- Статус: застосовано 2026-11-01 (integration): колонки `moderation_reasons`, `rejection_code`; міграція заповнює їх з нотаток `receipt_events`, модуль читає лише колонки.

## receipts-2: індекс для `sweep` черги `receipts-process`

- Файл і модель: `prisma/schema/receipts.prisma`, `Receipt`.
- Пропонований фрагмент:

  ```prisma
  @@index([status, updatedAt])
  ```

- Причина: кожні 10 хв `sweep` шукає незавершені чеки
  `WHERE status IN ('uploaded','parsed','auto_approved','approved') AND updated_at < $1 ORDER BY updated_at`
  (`ReceiptsRepository.listStuck`). Наявний індекс `(status, submitted_at)` частково допомагає, але
  сортування йде за `updated_at`.
- Вплив на міграцію: лише новий індекс; можна `CREATE INDEX CONCURRENTLY` вручну.
- Статус: застосовано 2026-11-01 (integration): `receipts_status_updated_at_idx`.

English summary: (1) persist moderation reasons and the rule rejection code as columns instead of
encoding them in receipt event notes; (2) index `(status, updated_at)` for the receipts-process sweep.
