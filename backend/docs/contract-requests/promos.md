# promos-1: локальні коди помилок бек-офісу у `PROMOS_ERROR_CODES`

- Що потрібно: додати до `PROMOS_ERROR_CODES` (`src/common/contracts/promos.ts`) коди, які модуль уже
  реєструє в `src/modules/promos/domain/errors.ts`:

  ```ts
  'PC_PROMO_INVALID_TRANSITION', // 409
  'PC_PROMO_DATES_INVALID', // 422
  'PC_PROMO_TENANT_NOT_FOUND', // 422
  'PC_PROMO_TEMPLATE_REQUIRED', // 422
  'PC_PROMO_NOT_DRAFT', // 409
  'PC_COUPON_TEMPLATE_NOT_FOUND', // 404
  'PC_COUPON_TEMPLATE_IN_USE', // 409
  'PC_COUPON_TEMPLATE_LIMITS_INVALID', // 422
  'PC_EVENT_INVALID_TRANSITION', // 409
  'PC_EVENT_DATES_INVALID', // 422
  'PC_EVENT_CAPACITY_INVALID', // 422
  'PC_EVENT_NOT_DRAFT', // 409
  'PC_EVENT_CANCEL_DEADLINE_PASSED', // 422 (учасник скасовує після 11:00 у день події)
  'PC_EVENT_REGISTRATION_NOT_FOUND', // 404
  'PC_EVENT_REGISTRATION_FINAL', // 409
  ```

- Для чого: BRIEF розділ 3 (коди `PC_<MODULE>_<REASON>`), CRUD `/admin/promos`, `/admin/coupon-templates`,
  `/admin/events` і `DELETE /events/:id/register`. `ClaimValidation` порту використовує лише коди з контракту.
- Коли: не блокує; коди працюють локально.
- Статус: виконано 2026-11-01 (integration).

English summary: list promos-local back-office error codes in `PROMOS_ERROR_CODES`.
