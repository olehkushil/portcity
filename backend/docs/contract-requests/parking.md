# Запити модуля parking на зміни контрактів

Дата: 2026-11-01. Споживач і власник подано в кожному пункті. Код модуля вже працює проти локальних
визначень (`src/modules/parking/domain/*`) і перейде на контракт після погодження.

## 1. parking -> foundation (`src/common/contracts/parking.ts`): коди помилок

- Що потрібно: додати до `PARKING_ERROR_CODES` п'ять кодів, які модуль уже реєструє в
  `src/modules/parking/domain/errors.ts`:
  ```ts
  'PC_PARKING_VEHICLE_LIMIT',          // 422, більше PARKING_MAX_VEHICLES авто
  'PC_PARKING_LOOKUP_LIMIT',           // 429, квота сесій неверифікованих номерів (10/год)
  'PC_PARKING_SESSION_ACTIVE_EXISTS',  // 409, другий таймер інфо-режиму
  'PC_PARKING_WEBHOOK_SIGNATURE',      // 401, підпис вебхука оператора
  'PC_PARKING_WEBHOOK_MALFORMED',      // 400, тіло вебхука оператора
  ```
- Для чого: BRIEF розділ 8 (`GET /parking/session` з лімітом 10 запитів на годину, вебхук
  `POST /webhooks/parking/:provider`, інфо-режим).
- Коли: не блокує (коди вже працюють), потрібне для повноти реєстру.

## 2. parking -> foundation (`src/common/contracts/events.ts`): події-нагадування

- Що потрібно: додати до `PARKING_EVENTS` і `OutboxEventPayloads`:
  ```ts
  freeEnding: 'parking.session.free_ending',   // за 5 хв до кінця безкоштовного часу (F2)
  exitSoon: 'parking.session.exit_soon',       // за 10 хв до paidUntil (F4)
  stillInside: 'parking.session.still_inside', // F7: payable 5 год від в'їзду або overstay 2 год

  export type ParkingSessionReminderPayload = ParkingSessionPayload & {
    reminder: 'free_ending' | 'exit_soon' | 'still_inside';
    deadline: IsoDateTime;      // кінець безкоштовного часу / paidUntil / поріг F7
    minutesLeft: number;
    source: ParkingSessionSource;
    amountDueKopecks: Kopecks;
    paidUntil: IsoDateTime | null;
  };
  ```
  Модуль уже публікує ці події з таким payload (`src/modules/parking/domain/parking-events.ts`,
  `PARKING_REMINDER_EVENTS`, `ParkingReminderPayload`) через `OutboxService.publish`, яка перевіряє
  лише формат назви.
- Для чого: дизайн-бриф 4.1 (сповіщення «Безкоштовні 30 хв закінчуються о 14:30», «Виїзд до 16:00 —
  залишилось 10 хв», «Ви ще на паркінгу?»); завдання модуля: нагадування через outbox.
- Коли: не блокує parking; блокує сповіщення (див. п. 3).

## 3. parking -> notifications (`src/common/contracts/notifications.ts` + модуль notifications)

- Що потрібно:
  - нові види в `NOTIFICATION_KINDS`: `parking_free_ending`, `parking_exit_soon`, `parking_still_inside`;
  - обробка подій з п. 2 у `mapOutboxEvent` і додавання їх до `HANDLED_EVENT_TYPES` (маршрут на
    `notifications-events`); тексти - канон дизайн-брифу 4.1 (наведено вище);
  - (бажано) обробка `parking.session.opened`: «Ви на паркінгу Порт City. Безкоштовно до 14:30»;
  - (бажано) окремий текст для `parking.session.closed` з `closedReason` `user_left` (спірна сесія,
    «звернення з ID сесії») і `timeout`.
- Для чого: дизайн-бриф 4.1, колонка «Сповіщення».
- Коли: можна до інтеграції. Доки notifications не споживає нагадування, parking маршрутизує їх у власну
  чергу `parking-events` і там підтверджує (щоб диспетчер не скидав їх як немаршрутизовані); після
  підключення notifications маршрут parking можна прибрати або лишити (подія розходиться в обидві черги).

## 4. parking -> foundation (`src/common/contracts/admin.ts`): прапорець тривоги

- Що потрібно: `FEATURE_FLAG_KEYS.parkingAirRaid = 'parking.air_raid'` (payload
  `{ startedAt?: IsoDateTime, freeExitMinutes?: number }`); модуль поки використовує локальну константу
  `PARKING_AIR_RAID_FLAG`.
- Для чого: дизайн-бриф 4.3 (джерело тривоги в Релізі 1 - прапорець, який вмикає черговий), правило
  оператора «виїзд безкоштовний у перші 30 хв».
- Коли: не блокує; seed має створити рядок прапорця вимкненим (див. `docs/schema-requests/parking.md`).

## Рішення integration (2026-11-01)

- Пункт 1: виконано, коди в `PARKING_ERROR_CODES`.
- Пункт 2: виконано - `PARKING_EVENTS.sessionFreeEnding|sessionExitSoon|sessionStillInside`, `ParkingSessionReminderPayload`; власний маршрут parking прибрано.
- Пункт 3: виконано - види `parking_opened`, `parking_free_ending`, `parking_exit_soon`, `parking_still_inside`, канонічні тексти, окремі тексти закриття `user_left` і `timeout`.
- Пункт 4: виконано - `FEATURE_FLAG_KEYS.parkingAirRaid`, seed створює рядок вимкненим.
