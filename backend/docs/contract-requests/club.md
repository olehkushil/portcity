# Запити та примітки модуля club щодо контрактів

Модуль club - власник `src/common/contracts/club.ts`, але `src/common/**` на етапі модулів
редагує лише integration-агент, тому уточнення власного контракту оформлено тут.

## club-1: уточнити семантику `spend` для ручних списань (club -> контракт club)

- Що потрібно: доповнити JSDoc `ClubLedgerPort.spend` у `src/common/contracts/club.ts`:

  ```ts
  /**
   * FIFO by expiry. Throws PC_POINTS_INSUFFICIENT, PC_POINTS_ACCOUNT_NEGATIVE or
   * PC_POINTS_NEWCOMER_LOCK (all 422) when spending is not allowed.
   * `sourceType: 'manual'` (back-office deduction) is written as a negative `adjust` row and is
   * not subject to the newcomer lock; balance checks still apply. Other sources write `spend`.
   */
  spend(input: SpendPointsInput, tx?: Tx): Promise<LedgerEntry>;
  ```

- Для чого: модуль admin робить від'ємні коригування через `spend` з `sourceType: 'manual'`
  (`adjustments.service.ts`); реалізація вже так працює, контракт має це казати явно.
- Коли: не блокує.
- Статус: виконано 2026-11-01 (integration).

## club-2: `PointsReversedPayload` для скасованого утримання

- Що потрібно (на розсуд integration): додати необов'язкове поле до `PointsReversedPayload` в
  `src/common/contracts/events.ts`:

  ```ts
  /** Pending points withdrawn by cancelling a hold (0 when the reversal hit the available balance). */
  pendingAmount?: Points;
  ```

- Для чого: за контрактом `amount` - вплив на доступний баланс, тому при скасуванні `pending`-рядка
  club публікує `amount: 0`. Споживач (сповіщення "бали за чек скасовано") не бачить кількість
  скасованих балів без додаткового запиту `getEntry(reversedTxId)`. Зараз події `points.reversed`
  ніхто не споживає.
- Коли: не блокує.
- Статус: виконано 2026-11-01 (integration): `pendingAmount?` у `PointsReversedPayload`, club заповнює його.

## club-3: застаріла перевірка заглушки в `test/e2e/ports.e2e-spec.ts` (для integration)

- Що потрібно: тест `a stub port answers 501 PC_COMMON_NOT_IMPLEMENTED until the module is built`
  бере саме `CLUB_LEDGER_PORT`. Тепер це справжній `LedgerService`: `getBalance('user-1')`
  повертає `null`, тож тест падає (1 із 15 у `npm run test:e2e`; решта проходить, `AppModule`
  стартує з модулем club). Запропоновано перевести тест на порт модуля, який ще є заглушкою, або
  прибрати його; перевірку club покриває `test/club/club.e2e-spec.ts` (порт - `LedgerService`).
- Коли: блокує зелений `npm run test:e2e`.
- Статус: виконано 2026-11-01 (integration): тест перевіряє справжні реалізації всіх дев'яти портів (заглушок не лишилося).

## Відповідь на content-5 (базова ставка для картки орендаря)

Club не заперечує варіант (б): `ContentModule` може імпортувати `ClubModule` (club залежить лише від
identity, циклу немає). `getActiveRules()` без аргументу кешується в club на 30 с і без жодної
версії правил повертає `DEFAULT_LOYALTY_RULES` (версія 0), тож власний fallback у content
потрібен лише на випадок недоступності БД.

English summary: (1) document in the club contract that `spend` with `sourceType: 'manual'` writes a
negative `adjust` row and skips the newcomer lock; (2) optional `pendingAmount` on
`PointsReversedPayload` (cancelled holds publish `amount: 0`); (3) the foundation e2e test that expects
the club stub to answer 501 is obsolete now that the ledger is real; answer to content-5: importing
`ClubModule` from content is fine.
