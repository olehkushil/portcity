# Запити модуля notifications на зміни контрактів

## 1. notifications-to-identity: аудиторія маркетингових розсилок

- Що потрібно: метод `IdentityPort` (`src/common/contracts/identity.ts`), що віддає учасників з
  чинною згодою `marketing` і хоча б одним push-пристроєм, сторінками:

  ```ts
  export interface IdentityPort {
    // ...
    /** Active users whose latest `marketing` consent is granted; cursor = last user id. */
    listMarketingAudience(
      cursor: Uuid | null,
      limit: number,
    ): Promise<{ userIds: Uuid[]; nextCursor: Uuid | null }>;
  }
  ```

- Для чого: подія `promo.published` (BRIEF розділи 3 і 9) має стати маркетинговим повідомленням
  `promo_published` для тих, хто погодився. Зараз `MarketingAudience.listUserIds()` повертає порожній
  список (`TODO(contract: identity.listMarketingAudience)`), тож розсилка - no-op з записом
  `marketing broadcast has no audience source yet` у результаті задачі.
- Коли: не блокує MVP; потрібне до запуску маркетингових push.

## 2. Код `PC_NOTIFICATION_PREFERENCE_LOCKED` у `NOTIFICATIONS_ERROR_CODES`

- Що потрібно: додати `'PC_NOTIFICATION_PREFERENCE_LOCKED'` (422) до `NOTIFICATIONS_ERROR_CODES`
  у `src/common/contracts/notifications.ts`.
- Для чого: `PUT /notifications/preferences` відхиляє вимкнення службових видів (платежі, акаунт,
  системні). Код уже зареєстровано локально в `src/modules/notifications/domain/errors.ts`.
- Коли: не блокує.

Статус: обидва пункти виконано 2026-11-01 (integration): `IdentityPort.listMarketingAudience` (identity реалізує, notifications розсилає сторінками по 500), код у `NOTIFICATIONS_ERROR_CODES`.

English summary: (1) an identity port method listing members with marketing consent for
`promo.published` broadcasts; (2) list the local error code `PC_NOTIFICATION_PREFERENCE_LOCKED`.
