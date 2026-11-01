# admin-1: колонка `userId` у `ManualAdjustment`

- Файл і модель: `prisma/schema/admin.prisma`, модель `ManualAdjustment` (файл admin, але міграцію
  веде schema/integration-агент).
- Пропонований фрагмент:

  ```prisma
  model ManualAdjustment {
    // ...
    /// Owner of the adjusted account, copied at request time (avoids reading loyalty_accounts).
    userId String @map("user_id") @db.Uuid
    // ...
    @@index([userId, createdAt])
  }
  ```

- Причина: `AdjustmentsService` показує й публікує в подіях `userId` власника рахунку. Зараз він
  читає `loyalty_accounts.user_id` через `include: { account: { select: { userId: true } } }`, тобто
  читає таблицю club напряму (BRIEF розділ 3 дозволяє лише через порт). `ClubLedgerPort.getBalance(userId)`
  повертає `accountId` за `userId`, але зворотного методу немає. Колонка прибирає залежність і
  спрощує фільтр `GET /admin/adjustments?userId=` (без виклику леджера).
- Вплив на міграцію: заповнити `user_id` з `loyalty_accounts` для наявних рядків
  (`UPDATE manual_adjustments m SET user_id = a.user_id FROM loyalty_accounts a WHERE a.id = m.account_id`),
  потім `NOT NULL`. Сумісність коду: після застосування сервіс пише `userId` при створенні і читає його
  замість `account.userId` (зміна в одному місці - `ADJUSTMENT_INCLUDE` і мапер у
  `services/adjustments.service.ts`).
- Статус: застосовано 2026-11-01 (integration): колонка `user_id` + FK на `users` + індекс `(user_id, created_at)`, заповнення з `loyalty_accounts` у міграції `20261101120000_module_requests`; сервіс пише й читає колонку.

English summary: add `userId` to `ManualAdjustment` so the admin module stops reading
`loyalty_accounts.user_id` through a Prisma relation.
