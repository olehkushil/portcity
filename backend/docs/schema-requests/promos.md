# promos-1: таблиця заявок на купон `CouponClaim`

- Файл і модель: `prisma/schema/promos.prisma`, нова модель `CouponClaim`.
- Пропонований фрагмент:

  ```prisma
  enum CouponClaimStatus {
    active
    cancelled
  }

  /// One row per coupon claim; the coupon itself is a voucher (kind coupon, sourceType promo, sourceId = id).
  model CouponClaim {
    id               String            @id @db.Uuid
    promoId          String            @map("promo_id") @db.Uuid
    couponTemplateId String            @map("coupon_template_id") @db.Uuid
    userId           String            @map("user_id") @db.Uuid
    voucherId        String?           @unique @map("voucher_id") @db.Uuid
    status           CouponClaimStatus @default(active)
    createdAt        DateTime          @default(now()) @map("created_at") @db.Timestamptz(6)
    cancelledAt      DateTime?         @map("cancelled_at") @db.Timestamptz(6)

    promo          Promo          @relation(fields: [promoId], references: [id], onDelete: Restrict)
    couponTemplate CouponTemplate @relation(fields: [couponTemplateId], references: [id], onDelete: Restrict)

    @@index([promoId, userId, status])
    @@index([couponTemplateId])
    @@map("coupon_claims")
  }
  ```

  (плюс зворотні поля `claims CouponClaim[]` у `Promo` і `CouponTemplate`).

- Причина: BRIEF розділ 4 описує `perUserLimit`/`totalLimit` шаблону, але не таблицю заявок. Зараз
  модуль відновлює історію учасника перебором детермінованих `claimId` (слоти 1..perUserLimit+10) через
  `VOUCHER_ISSUER_PORT.listBySource` - до 11 викликів порту на заявку і жорстка межа на кількість
  скасованих купонів. Таблиця дає один запит, звітність по акції (хто і коли забрав купон) і чисте
  повернення купона в пул без читання `meta` ваучера.
- Вплив на міграцію: нова таблиця без заповнення (наявні купони можна перенести скриптом за
  `vouchers.source_type = 'promo'`, `meta->>'claimId'`). Код перейде на таблицю в одному сервісі
  (`services/promos.service.ts`, `loadClaimSlots`), API не змінюється.
- Статус: застосовано 2026-11-01 (integration): модель `CouponClaim` (`coupon_claims`) як запропоновано; міграція переносить наявні купони (`vouchers.kind = coupon`, `meta.promoId`), сервіс перейшов на таблицю.

English summary: add a `coupon_claims` table so claims are not reconstructed from deterministic
voucher source ids.
