# admin-1: локальні коди помилок admin у `ADMIN_ERROR_CODES`

- Що потрібно: додати до `ADMIN_ERROR_CODES` у `src/common/contracts/admin.ts` коди, які модуль
  вже реєструє в `src/modules/admin/domain/errors.ts`:

  ```ts
  export const ADMIN_ERROR_CODES = [
    // ... наявні
    'PC_ADJUSTMENT_AMOUNT_INVALID', // 422: amount = 0, не ціле або за межами +-1 000 000
    'PC_ADJUSTMENT_ACCOUNT_NOT_FOUND', // 404: у користувача ще немає рахунку лояльності
    'PC_FEATURE_FLAG_KEY_INVALID', // 400: ключ не у форматі `parking.info_mode`
    'PC_REPORT_DAY_INVALID', // 400: день не `yyyy-MM-dd` або діапазон перевернутий/завеликий
  ] as const;
  ```

- Для чого: BRIEF розділ 3 (коди `PC_<MODULE>_<REASON>`), ендпоїнти `POST /admin/adjustments`,
  `PUT /admin/feature-flags/:key`, `GET /admin/reports/daily[/range]`. Клієнт бек-офісу має бачити повний
  перелік кодів у контракті.
- Коли: не блокує; коди вже працюють локально (реєстр `defineErrorCodes` глобальний).
- Статус: виконано 2026-11-01 (integration).

English summary: list four admin-local error codes in the contract's `ADMIN_ERROR_CODES`.
