# Запити модуля identity на зміни контрактів і спільного шару

Автор: identity-агент, 2026-11-01. Жоден пункт не блокує модуль: код працює з поточними контрактами,
нижче - що варто додати під час інтеграції.

## 1. Події `user.deletion_cancelled` і `user.unblocked` (власник: `src/common/contracts/events.ts`)

- Що потрібно:

  ```ts
  export const IDENTITY_EVENTS = {
    // ...наявні
    deletionCancelled: 'user.deletion_cancelled',
    unblocked: 'user.unblocked',
  } as const;
  export type UserDeletionCancelledPayload = {
    userId: Uuid;
    requestId: Uuid;
    cancelledAt: IsoDateTime;
  };
  export type UserUnblockedPayload = { userId: Uuid };
  // OutboxEventPayloads: 'user.deletion_cancelled', 'user.unblocked'
  ```

- Для чого: `DELETE /me/deletion` (скасування запиту на видалення в період охолодження) і
  `POST /admin/users/:id/unblock`. Зараз identity публікує `user.deletion_requested` і `user.blocked`,
  але не має як повідомити споживачів про скасування/розблокування (наприклад, notifications могли б
  відновити розсилки, club - зняти обмеження).
- Коли: може почекати до інтеграції. Поки що скасування й розблокування лише записуються в аудит.

## 2. Маршрути для подій identity (споживачі: club, notifications, receipts, parking, payments)

- Identity публікує: `user.registered`, `user.profile_completed`, `user.device_registered`,
  `user.blocked`, `user.deletion_requested`, `user.deleted`.
- Диспетчер видаляє події без маршруту приблизно через 5 хвилин з error-логом. Потрібно, щоб
  модулі-споживачі зареєстрували маршрути: club - `user.registered`, `user.profile_completed`
  (рахунок і welcome-бонуси); модулі з персональними даними (receipts - фото чеків, parking - номери
  авто, notifications - вхідні, payments) - `user.deleted` для очищення своїх даних після
  анонімізації. Якщо подія нікому не потрібна (`user.device_registered`, `user.deletion_requested`),
  інтеграційний агент може зареєструвати для неї no-op маршрут або вилучити публікацію - скажіть, і
  identity прибере її.
- Коли: до першого запуску worker з реальними даними.

## 3. Перевірка активності адміністратора в `AdminGuard` (власник: `src/common/auth`)

- Проблема: admin access JWT stateless і живе `ADMIN_ACCESS_TTL_SECONDS` (8 год за замовчуванням).
  Деактивований адміністратор або адміністратор зі зміненою роллю зберігає доступ до ендпоїнтів
  інших модулів до кінця терміну токена.
- Що зроблено локально: identity має `ActiveAdminGuard` (`src/modules/identity/controllers/active-admin.guard.ts`),
  який на ендпоїнтах identity (`/admin/users`, `/admin/admin-users`) перевіряє `AdminUser.active` і
  відповідність ролі в токені.
- Пропозиція: додати в `IdentityPort` метод
  `getAdminAccess(adminId: Uuid): Promise<{ active: boolean; role: AdminRole } | null>` і викликати
  його з `AdminGuard` (з коротким кешем у пам'яті на 30-60 с), або скоротити TTL admin-токенів до
  15-30 хв і додати admin refresh-токени (потребує таблиці, див. `docs/schema-requests/identity.md`).
- Коли: до релізу бек-офісу.

## Рішення integration (2026-11-01)

- Пункт 1: виконано - `user.deletion_cancelled` і `user.unblocked` у каталозі, identity публікує їх; notifications споживає `user.deletion_cancelled`, `user.unblocked` - лише аудит.
- Пункт 2: виконано - кожна подія каталогу має маршрут або явний статус "лише аудит" (`src/common/outbox/audit-only-events.ts`, перевіряє `test/e2e/outbox-routes.e2e-spec.ts`); `user.deleted` споживають receipts, parking, payments, notifications і rewards.
- Пункт 3: виконано - `IdentityPort.getAdminAccess`, спільний `AdminGuard` через `AdminAccessGate` (кеш `ADMIN_ACCESS_CACHE_SECONDS`, типово 30 с); TTL admin-токена лишився 8 год, `ActiveAdminGuard` прибрано.
