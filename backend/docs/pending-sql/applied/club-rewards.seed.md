> **Застосовано (архів).** Внесено в `prisma/seed.ts` 01.11.2026 (схема - міграцією
> `20261101180000_review_fixes`): PIN за замовчуванням `246813`, розподіл списання
> `spend-coffee` у `points_spend_allocations`, `title`/`subtitle`/`counterparty` рядків леджера,
> `.env.example` (`REWARDS_REFUND_ON_EXPIRY`, `PROFILE_BONUS_*`) і секція `club` у
> `env-example.spec.ts`. Не внесено: `imageKey` ваучера (у демо-винагороди немає зображення).

# Seed: зміни для club + rewards (виправлення рев'ю 2026-11-01)

`prisma/seed.ts` не редагувався (власник - integration). Нижче - що варто внести, щоб демо-дані
відповідали новій поведінці. Усі пункти необов'язкові для роботи коду: без них seed лишається
валідним (нові колонки nullable або мають default).

## 1. PIN демо-валідатора (знахідка 8)

- Нові та змінені PIN тепер мають 6-12 цифр (`NEW_PIN_PATTERN`). Відкриття зміни все ще приймає
  4-12 цифр, тож поточний дефолт `SEED_VALIDATOR_PIN=1234` працює, але його не можна буде
  повторно встановити через `POST /admin/validator-devices/:id/pin`.
- Рекомендовано: `DEFAULT_VALIDATOR_PIN = '246813'` у `prisma/seed.ts` (коментар у шапці файлу
  "default 1234" теж) і `SEED_VALIDATOR_PIN=246813` в `.env.example`, а також оновити
  `docs/FOUNDATION_SUMMARY.md` розділ 8/11 (там згадано `1234`).
- `failed_pin_attempts` / `pin_locked_until` мають default (0 / NULL) - у seed нічого не потрібно.

## 2. Розподіл списання по кошиках (знахідка 2)

Демо-рядок `seed:demo:spend-coffee` (-60) не має записів у `points_spend_allocations`, тому його
повернення дасть свіжий строк (`now + 12 міс`), як для будь-якого рядка до міграції. Щоб демо
показувало нову поведінку, після вставки рядків леджера додати (FIFO: найраніший кошик - день
`welcome-register`):

```ts
await prisma.pointsSpendAllocation.createMany({
  data: [
    {
      spendTxId: txIds.get('spend-coffee')!,
      // Kyiv day of computeExpiresAt(d0, 12): the bucket the 60 points were taken from
      // (50 from welcome-register, 10 from welcome-profile if they share the day).
      expiresOn: dayKeyToDate(bucketDayKey(computeExpiresAt(d0, RULE_SET_V1.pointsTtlMonths))),
      amount: 60,
    },
  ],
  skipDuplicates: true,
});
```

(точні дні - ті самі, що seed уже рахує для `points_expiry_buckets`; якщо `welcome-register` і
`welcome-profile` потрапляють у різні київські дні, розбити на два рядки 50 + 10).

## 3. Дані для історії балів (знахідка 10)

Нові nullable-колонки `title`, `subtitle`, `counterparty` у `points_transactions`. Старі рядки без
них отримують заголовок, похідний від типу, тож seed працює й так. Для гарнішого демо в `create`
кожного `txSeeds`-рядка можна додати:

| key                     | title                         | subtitle                      | counterparty                                                         |
| ----------------------- | ----------------------------- | ----------------------------- | -------------------------------------------------------------------- |
| `welcome-register`      | Вітальний бонус за реєстрацію | null                          | null                                                                 |
| `welcome-profile`       | Бонус за заповнений профіль   | null                          | null                                                                 |
| `earn-receipt-a`        | Нарахування за чек            | INTERTOP, 1 поверх            | `{ tenantName: 'INTERTOP', receiptId, receiptTotalKopecks: 600000 }` |
| `welcome-first-receipt` | Бонус за перший чек           | null                          | `{ receiptId }`                                                      |
| `adjust-compensation`   | Нарахування від ТРЦ           | Компенсація за технічний збій | null                                                                 |
| `spend-coffee`          | Обмін на винагороду           | Кава з собою                  | `{ rewardTitle: 'Кава з собою', tenantName: 'Aroma Kava' }`          |

(рядки вставляються через `upsert` з `update: {}` - існуючі в БД рядки не змінюються, і тригер
append-only цього й не дозволив би).

## 4. Зображення ваучерів (знахідка 6)

Демо-ваучер обміну `redemption:demo-coffee` може отримати `imageKey` винагороди «Кава з собою»
(`imageKey: <той самий ключ, що в rewards>`); бекфіл у `club-rewards.sql` (пункт 4) робить це й
для вже засіяної БД. `imageUrl` у відповідях з'являється лише при заданому `S3_PUBLIC_BASE_URL`.

## 5. `.env.example` (integration)

```
# Повертати бали за ваучер, куплений за бали, якщо він згорів невикористаним (true/false).
REWARDS_REFUND_ON_EXPIRY=true
# Бонус за кожне заповнене поле профілю (user.profile_field_completed).
PROFILE_BONUS_PER_FIELD=10
# Додатковий бонус, коли заповнено всі поля профілю.
PROFILE_BONUS_COMPLETE=20
```

`src/common/config/env-example.spec.ts` перевіряє секцію `rewards`: без рядка
`REWARDS_REFUND_ON_EXPIRY` тест "lists every variable of the rewards section" падає. Для змінних
club треба додати `['club', clubEnvSchema]` (`src/modules/club/club.config.ts`) у `SECTIONS`,
інакше тест "documents nothing that no schema reads" впаде після додавання рядків.
