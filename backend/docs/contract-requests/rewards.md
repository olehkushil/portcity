# Запити модуля rewards на зміни контрактів

## 1. Код помилки `PC_VALIDATOR_NOT_FOUND` у `REWARDS_ERROR_CODES`

- Що потрібно: додати `'PC_VALIDATOR_NOT_FOUND'` до масиву `REWARDS_ERROR_CODES` у
  `src/common/contracts/rewards.ts`.

  ```ts
  export const REWARDS_ERROR_CODES = [
    // ...наявні коди
    'PC_VALIDATOR_NOT_FOUND',
  ] as const;
  ```

- Для чого: бек-офіс пристроїв-валідаторів (BRIEF розділ 8, `/admin/validator-devices/:id`, revoke,
  rotate-key, pin, log) повертає 404 для невідомого пристрою. Код уже зареєстровано локально в
  `src/modules/rewards/domain/errors.ts` (`404 Validator device not found`), контракт лише фіксує назву.
- Коли: не блокує; можна застосувати під час інтеграції.

## 2. (Необов'язково) константи заголовків валідатора в `src/common/auth/auth.constants.ts`

- Що потрібно: поруч із `VALIDATOR_KEY_HEADER` додати
  `VALIDATOR_SHIFT_HEADER = 'X-Validator-Shift'` і `VALIDATOR_PIN_HEADER = 'X-Validator-Pin'`, а в
  OpenAPI-документі (`src/common/openapi`) описати їх як додаткові схеми `apiKey` в заголовку.
- Для чого: зараз константи живуть у `src/modules/rewards/services/validator.service.ts`, а заголовки
  документуються через `@ApiHeader` на кожному маршруті валідатора; клієнтам каси зручніше бачити їх
  у security schemes.
- Коли: не блокує.

Статус: обидва пункти виконано 2026-11-01 (integration): код у `REWARDS_ERROR_CODES`; `VALIDATOR_SHIFT_HEADER`, `VALIDATOR_PIN_HEADER` і схеми безпеки `validator-shift`, `validator-pin` у `src/common`.
