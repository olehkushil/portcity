# Запити модуля rewards на зміни схеми

## 1. Частковий унікальний індекс джерела ваучера

- Файл і модель: `prisma/schema/rewards.prisma`, `Voucher` (плюс SQL у міграції, бо Prisma не
  описує часткові індекси).
- Пропонований фрагмент (міграція):

  ```sql
  CREATE UNIQUE INDEX vouchers_source_kind_key
    ON vouchers (source_type, source_id, kind)
    WHERE source_id IS NOT NULL;
  ```

- Причина: `VoucherIssuerPort.issue` за контрактом ідемпотентний за `(sourceType, sourceId, kind)`.
  Зараз це перевірка `findFirst` перед вставкою; два паралельні виклики (повторна доставка події,
  подвійний клік у promos) можуть створити два ваучери. З індексом другий insert отримає P2002, а сервіс
  поверне наявний ваучер. Усі поточні джерела вже унікальні за цією трійкою: обмін (`redemptionId`),
  купон (слот заявки promos), квиток (`registrationId`), адмін-ваучер (новий id на кожну дію).
- Вплив на міграцію: лише новий індекс; перед застосуванням перевірити відсутність дублів
  (`SELECT source_type, source_id, kind, count(*) FROM vouchers WHERE source_id IS NOT NULL GROUP BY 1,2,3 HAVING count(*) > 1`).

## 2. Індекс для ліміту винагороди на учасника

- Файл і модель: `prisma/schema/rewards.prisma`, `Redemption`.
- Пропонований фрагмент:

  ```prisma
  @@index([userId, rewardId, status])
  ```

- Причина: `countUserRedemptions` / `countUserRedemptionsForRewards` (перевірка `perUserLimit` при
  обміні та в каталозі) фільтрують за `(user_id, reward_id, status)`; наявний індекс
  `(user_id, created_at desc)` покриває лише частину умови.
- Вплив на міграцію: лише новий індекс, без заповнення даних.

Статус: обидва пункти застосовано 2026-11-01 (integration): `vouchers_source_kind_key` (частковий унікальний, ручний SQL у міграції `20261101120000_module_requests`; `issue` вставляє з `ON CONFLICT DO NOTHING` і повертає наявний ваучер) і `redemptions_user_id_reward_id_status_idx`.
