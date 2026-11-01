# Модуль parking

Паркінг - перша вкладка і стартовий екран застосунку. Модуль веде авто учасників, сесії паркування
(з системи оператора або власний таймер учасника в інформаційному режимі), тарифний калькулятор,
оплату сесії через модуль payments, нагадування через outbox і задачу синхронізації `parking-sync`.

Надає `PARKING_PORT` (`ParkingService`) для rewards, notifications і admin. Залежить лише від
payments (`PAYMENTS_PORT`) і спільного шару. Реагує на події `payment.succeeded` і `user.deleted`.

## Структура

| Шлях | Що там |
| --- | --- |
| `domain/` | чиста логіка без Nest/Prisma: `tariff.ts` (калькулятор), `tariff-config.ts` (zod-схема тарифу), `tariff-describe.ts` (рядки тарифу українською), `session-state.ts` (стан-машина), `reconcile.ts` (крок звірки фактів), `session-view.ts` (модель читання для героя), `hero.ts` (стани F0-F7, I0-I4), `pay-charge.ts` (що списує «Сплатити», правило кінця години), `history.ts` (`paidVia`, місяць за Києвом), `reminders.ts`, `air-raid.ts`, `notices.ts` (банери 21:00 і нічний тариф), `parking-events.ts` (payload подій), `plate.ts`, `verification.ts`, `errors.ts` |
| `provider/` | `ParkingProviderPort` (абстрактний клас = DI-токен), `EmulatorParkingProvider`, `VendorParkingProvider` (заглушка), фабрика за `PARKING_PROVIDER` |
| `services/` | `SessionSyncService` (єдиний шлях запису сесій, журнал вебхуків), `SessionsService` (герой, «Я вже виїхав», «Так, я тут», «Це не моє авто», талон, історія і підсумок місяця), `VehiclesService`, `InfoModeService`, `ParkingPaymentsService` (оплата, `payment.succeeded`, повернення непотрібних оплат, sweep), `TariffService`, `ParkingService` (порт + бек-офіс), `AirRaidService`, `ParkingErasureService` (`user.deleted`), квоти `UnverifiedLookupLimiter` |
| `jobs/` | `parking-sync.job.ts` (логіка задачі) + процесор (`sync`, `payments-sweep`), `parking-events.handler.ts` (споживач outbox: `payment.succeeded`, `user.deleted`) + процесор, `long-retry.ts` (довга політика повторів `payment.succeeded`) |
| `controllers/`, `dto/` | HTTP і Swagger |
| `testing/` | `FakePrisma`, `FakeParkingProvider`, `FakePaymentsPort`, `ParkingHarness` (усі сервіси на фейках) |

## Модель даних (`prisma/schema/parking.prisma`)

- `Vehicle`: номер нормалізований (латиниця без пробілів, кириличні двійники `А В С Е Н І К М О Р Т Х`
  перетворюються на латиницю), `plateDisplay` (`AC 1234 BC`), `verified` / `verifiedVia`
  (`talon | paymat_code | operator | none`) / `verifiedAt`, `isDefault`, `label` (власна назва
  «Моя Škoda», до 40 символів), м'яке видалення. Один живий рядок на (учасник, номер) - частковий
  унікальний індекс у міграції. До 5 авто на учасника.
- `ParkingSession`: `source = provider | info_timer`, `providerRef` (унікальний id сесії в операторі),
  `status`, `level`/`spot` (рівень і ряд з останнього знімка оператора, наприклад `-2` / `C`;
  знімок без цих полів лишає збережені значення, з обома порожніми - очищає),
  `enteredAt`, `exitedAt`, `paidUntil`, `amountDueKopecks`, `amountPaidKopecks`,
  `lastSyncedAt` (для «оновлено HH:MM» і як маркер останньої оцінки), `closedReason`
  (`exit | user_left | user_exit | timeout | air_raid | privilege`). `userId`/`vehicleId` заповнені лише
  для верифікованих авто (або сесій, заявлених талоном); сесії неверифікованих номерів зберігаються без
  власника і шукаються за номером. Сесії авто, яких немає в жодного учасника, не зберігаються взагалі;
  сесія лише з талоном (камера не прочитала номер) зберігається з `plate = null` після заявки талоном.
  `presenceConfirmedAt` - останнє «Так, я тут» (F7); `disputedAt` / `disputeReason`
  (`not_my_car | wrong_amount | barrier`) / `disputeComment` - «Це не моє авто» (F2).
- `ParkingTariff`: версії тарифу (`config` jsonb), нова версія діє з `activeFrom`, старі не редагуються.
  Поки таблиця порожня, діє вбудований тариф (версія 0).
- `ParkingPaymentLink`: зв'язок сесії з кожною спробою оплати (сесію можна доплатити після
  прострочення; повторна спроба після відхиленої картки - окремий платіж і окремий зв'язок).
  `paidUntil` - виїзд, який купує платіж; `outcome` - що зробив `payment.succeeded`
  (`applied | refund_queued | alerted`), `outcomeAt`; `registeredAt` - коли оператор прийняв оплату
  (шлагбаум), поки порожнє - sweep повторює реєстрацію.
- `ParkingWebhookLog`: оброблені вебхуки оператора, `(provider, eventId)` унікальні (повтор того самого
  `eventId` не застосовується вдруге); старші за 30 днів видаляє sweep.

## Тариф (правила оператора)

Перші 30 хв безкоштовно; хвилини 31-60 - 20 ₴; кожна наступна розпочата година - 40 ₴; година, що
починається в 00:00-05:00 за Києвом, - 500 ₴; виїзд до кінця оплаченої години; втрата талона 500 ₴;
підземний контур 08:00-21:00, наземний 05:00-24:00; без застосунку оплата лише в паркоматі.

Канонічний приклад (`design/v2/CONVENTIONS.md`, дизайн-бриф розділ 4): в'їзд 14:00 на підземний контур,
безкоштовно до 14:30, 14:31-15:00 - 20 ₴, 15:00-16:00 - 40 ₴; о 15:20 до сплати 60 ₴, «Наступна година
почнеться о 16:00 (+40 ₴)»; оплата 60 ₴ о 15:20 - виїзд до 16:00; після 16:00 прострочення, доплата 40 ₴;
виїзд о 15:52 - «1 год 52 хв · 60 ₴». BRIEF розділ 11 називає 14:12, але тоді «60 ₴ о 15:20» і
«оплачено до 16:00» не узгоджуються з тарифом, тому емулятор і seed ідуть за каноном 14:00
(`docs/schema-requests/parking.md`, прийнято інтеграцією).

`GET /parking/tariff` повертає конфіг і готові рядки для екрана S06 («0–30 хв — безкоштовно»,
«31–60 хв — 20 ₴», «далі — 40 ₴/год», «00:00–05:00 — 500 ₴/год», «Втрата талона — 500 ₴», графік,
правило тривоги), побудовані з активної версії, тож застосунок не тримає цін у коді.

## Стан-машина і герой

```
open (30 хв безкоштовно) -> payable -> paid (виїзд до paidUntil) -> closed
                                    \-> overstay -> paid ; closed_unpaid (без оплати в застосунку) ;
                                        closed_free (тривога, пільга)
```

Статус - функція фактів (`enteredAt`, `paidUntil`, `exitedAt`, `closedReason`) і часу, тому повтор
тих самих фактів нічого не змінює. Закриті статуси фінальні: сесію не можна «відкрити» назад.

`GET /parking/session` повертає `heroState`, `actions` і все для героя:

| Стан | Умова | `actions` |
| --- | --- | --- |
| F0 | немає авто (повний режим) | `add_vehicle` (+ `start_timer`, якщо інфо-режим увімкнено) |
| F1 | авто є, сесії немає (або закрита понад 2 год тому) | `verify_vehicle`, лише поки є неверифіковане авто |
| F2 | `open` | `left` |
| F3 | `payable` | `pay`, `left` |
| F4 | `paid` | - |
| F5 | `overstay` | `pay`, `left` |
| F6 | `closed`, `closed_unpaid`, `closed_free` протягом 2 год після виїзду | - |
| F7 | `payable` понад 5 год від в'їзду або `overstay` понад 2 год після `paidUntil`; обидва пороги рахуються від останнього «Так, я тут», якщо воно пізніше | `pay`, `confirm_present`, `left` |
| I0 | інфо-режим, таймера немає | `start_timer` |
| I1 / I2 | таймер `open` / `payable` | `exit_timer` / `paid_at_paymat`, `exit_timer` |
| I3 | `paid` або `overstay` після «оплатив у паркоматі» | `paid_at_paymat`, `exit_timer` |
| I4 | таймер закрито менш ніж 2 год тому | `start_timer` |

Сесія в відповіді: `status` (перераховано на `serverTime`), `plate`/`plateDisplay`, `zone`,
`level`/`spot` (якщо оператор знає), `enteredAt`, `freeUntil`, `amountDueKopecks`, `amountPaidKopecks`,
`currentHourEndsAt` (що купує оплата зараз), `nextCharge` («Затримаєтесь — 20 ₴ до 15:00» / «+40 ₴»),
`paidUntil`, `durationMinutes`, `stayTotalKopecks` (вартість перебування за тарифом, для I4),
`breakdown` (рядки тарифу), `lastSyncedAt` і `lastSyncedAtLabel` («оновлено 15:20»), `freeExitUntil`
(тривога), `payNow { amountKopecks, paidUntil, includesNextHour }` (що спише «Сплатити» зараз, див.
«Оплата»), `presenceConfirmedAt`, `payments[] { id, amountKopecks, paidAt, paidUntil, status }`
(усі спроби оплати в застосунку, для екрана квитанції - `GET /payments/:id`), `disputedAt`.
Поруч: `vehicles`, `defaultVehicle`, `restricted`, `lookupQuota`, `airRaid`, `notices`
(`air_raid`, `underground_closing_soon`, `underground_closed`, `night_tariff_soon`), `providerAvailable`
(false, коли оператор не відповів - дані з бази на момент `lastSyncedAt`), `mode` (`info`, коли
увімкнено прапорець `parking.info_mode`).

Порядок вибору сесії: сесія оператора верифікованого авто (оновлюється з оператора, якщо копія старша
за `PARKING_SESSION_STALE_MS`; якщо в базі нічого немає - запит до оператора за номерами, не частіше
разу на хвилину на номер), далі таймер інфо-режиму, далі сесія, закрита менш ніж 2 год тому. Сесія
оператора має пріоритет над таймером навіть в інфо-режимі (дані реальні). Оскаржені сесії
(«Це не моє авто») у героя не потрапляють ніколи.

## Дії учасника на сесії

- «Так, я тут» (F7): `POST /parking/session/:id/still-here` записує `presenceConfirmedAt`; пороги F7
  (5 год для `payable`, 2 год для `overstay`) і нагадування `parking.session.still_inside` рахуються від
  нього. Факти й маркер синхронізації не змінюються. Відповідь - герой.
- «Це не моє авто» (F2), «сума неправильна», «шлагбаум не відкрився»:
  `POST /parking/session/:id/dispute { reason: not_my_car | wrong_amount | barrier, comment? }` ставить
  `disputedAt`, сесія зникає з героя, не надсилає нагадувань і подій, не оплачується, не видається
  `PARKING_PORT.getSessionForUser`; публікується `parking.session.disputed` (споживає notifications).
  Сесія лишається в історії з `disputed: true`; підтримка бачить їх у
  `GET /admin/parking/sessions?disputed=true`. Повторний виклик нічого не змінює. Відповідь - герой.
- Заявка талоном: `POST /parking/sessions/claim { talonCode }` (`Idempotency-Key`, 10 заявок на годину
  на учасника, `429 PC_PARKING_CLAIM_LIMIT`). Оператор шукає сесію за талоном
  (`ParkingProviderPort.findSessionByTalon`; невідомий талон - `404 PC_PARKING_TALON_UNKNOWN`,
  оператор недоступний - 503). Сесія прив'язується до учасника (лише з талоном - з `plate = null`;
  якщо номер збігається з авто учасника - з цим авто), сесія іншого акаунта або номер, верифікований
  в іншому акаунті - `409 PC_PARKING_SESSION_CLAIMED`. Відповідь - герой; таку сесію можна оплатити
  в застосунку (талон - доказ присутності). Емулятор знає талон `PC-0418227`
  (`EMULATOR_TIMELINE.talonCode`, та сама часова лінія, що й демо-номер); vendor-заглушка - 503.

## Неверифіковані номери

Номер, доданий без талона чи коду паркомата, бачить лише `restricted: { amountDueKopecks, paidUntil }`
(плюс власний номер), без можливості оплати. Кожен такий запит з'їдає одиницю квоти: 10 на годину на
учасника (`PARKING_UNVERIFIED_LOOKUPS_PER_HOUR`). Коли квоту вичерпано і показати більше нічого
(повний режим, жодного верифікованого авто), відповідь `429 PC_PARKING_LOOKUP_LIMIT` з `resetAt`;
інакше герой віддається без `restricted`. Квота в Redis (`INCR`/`PEXPIRE`, спільна для реплік), коли
розгортання працює з Redis (`QUEUE_DRIVER=redis`), інакше в пам'яті процесу; при збої Redis -
резерв у пам'яті.

Верифікація: `POST /parking/vehicles/:id/verify { talonCode | paymatCode }` (рівно одне поле, 10 спроб
на годину з IP і 5 спроб за 24 год на авто учасника - ключ «учасник + номер», тож видалення й повторне
додавання авто квоту не скидає; понад це `429 PC_PARKING_VERIFICATION_LIMIT` з `resetAt`). Оператор
звіряє код із номером. Номер, уже верифікований в іншому акаунті, дає
`409 PC_PARKING_VERIFICATION_FAILED` з `reason = verified_in_other_account` («Номер уже активний в іншому
акаунті — зверніться в підтримку»). Після верифікації анонімні активні сесії цього номера
прив'язуються до учасника, публікується `parking.vehicle.verified`.

## Провайдер (оператор паркінгу)

`ParkingProviderPort`: `listActiveSessions`, `findSessionByPlate`, `getSessionByRef`,
`findSessionByTalon` (сесія за талоном, без номера, якщо камера його не прочитала), `registerPayment`
(ідемпотентно за `paymentId`), `verifyVehicle`, `parseWebhook` (підпис + розбір). Будь-який метод може
кинути `503 PC_PARKING_PROVIDER_UNAVAILABLE`.

- `emulator` (типово): відтворює канонічну історію для демо-номера `PARKING_EMULATOR_PLATE`
  (`AC1234BC`, підземний рівень -2, ряд C). Сценарій `PARKING_EMULATOR_SCENARIO`:

  | Сценарій | Що відбувається |
  | --- | --- |
  | `free` | в'їзд 14:00, оплати немає (до 14:30 безкоштовно, далі платний час) |
  | `payable` | те саме; о 15:20 до сплати 60 ₴ (стартовий екран F3) |
  | `paid` | о 15:20 оплачено 60 ₴ до 16:00; після 16:00 - прострочення |
  | `closed` | як `paid` + виїзд о 15:52 |

  `PARKING_EMULATOR_ANCHOR=today` (типово, як seed): факти з'являються о відповідній годині поточного
  київського дня. `now`: часова лінія один раз зсувається при старті так, щоб «зараз» було моментом
  сценарію (`free` 14:11, `payable` 15:20, `paid` 15:25, `closed` 15:55) - для демо в будь-який час,
  далі все йде в реальному часі. Оплати з застосунку емулятор додає до сесії в пам'яті. Верифікація в
  емуляторі: цифри коду закінчуються цифрами номера (`771234` або `1234` для `AC1234BC`). Друга
  демо-сесія `emu-talon-session` - та сама часова лінія без номера, знаходиться лише за талоном
  `PC-0418227` (регістр, пробіли й дефіси не важливі).
- `vendor`: заглушка реального оператора (вендор і його API ще не обрані). Кожен виклик - 503, тож
  застосунок працює в інфо-режимі й чесно відправляє до паркомата. Тут з'явиться реальний адаптер.

Вебхук `POST /webhooks/parking/:provider` (публічний): `:provider` має збігатися з налаштованим
адаптером, інакше 404. Формат емулятора: `{ eventId, type?, session: { providerRef, plate?, zone?,
enteredAt, exitedAt?, paidUntil?, amountPaidKopecks?, amountDueKopecks?, closedReason?, level?, spot? } }`,
підпис `X-Parking-Signature: sha256=<HMAC-SHA256 hex точних байтів тіла запиту>` з
`PARKING_WEBHOOK_SECRET`. Байти бере контролер з `request.rawBody` (`rawBody: true` у
`NestFactory.create`), тож переформатування JSON (пробіли, порядок ключів) ламає підпис. Лише для
викликів усередині процесу, де сирого тіла немає, адаптер підписує канонічний JSON.
Кожен `eventId` записується в `parking_webhook_logs` (`(provider, eventId)` унікальні): повторна доставка
того самого `eventId` підтверджується з `duplicate: true` і не застосовується вдруге (стара подія,
повторена оператором після новіших фактів, не відкотить сесію); паралельний дубль ловить унікальний
індекс. Якщо застосування впало, рядок журналу видаляється, тож повтор оператора обробиться. Факти
йдуть тим самим шляхом, що й синхронізація. Номери не учасників підтверджуються (`tracked: false`) і не
зберігаються.

## Єдиний шлях запису і конкурентність

`SessionSyncService.applyFacts` - єдине місце, де змінюється сесія: залишає закриті сесії як є,
застосовує правило тривоги до виїзду, планує стан чистою `planSession`, шукає нагадування, записує з
compare-and-set за (`status`, `lastSyncedAt`) і публікує події outbox у тій самій транзакції.
Конкурентні записувачі (вебхук, такт синхронізації, оновлення на GET) не публікують перехід двічі;
дії учасника й оплати при конфлікті перечитують рядок і застосовуються повторно (до 3 спроб).
Оплачений період зливається монотонно (пізніший `paidUntil`, більша сума), тож оператор, що відстає
від оплати в застосунку, не забирає оплачений час.

«Я вже виїхав» (`POST /parking/session/:id/left`): сесія закривається моментом натискання з причиною
`user_left`; якщо щось було до сплати - статус `closed_unpaid` (спірна сума для звірки оператором за
рунбуком), нічого не списується автоматично. Подальші факти оператора цю сесію не відкривають.

## Оплата

`POST /parking/session/:id/pay` (`Idempotency-Key` обов'язковий): лише сесія оператора верифікованого
авто учасника (або заявлена талоном), не оскаржена; сума перечитується з оператора безпосередньо перед
оплатою (оператор недоступний - 503, «сплатіть у паркоматі»); нічого до сплати -
`409 PC_PARKING_NOTHING_DUE`.

**Кінець години.** Якщо до кінця поточної (оплачуваної) години лишилося менше
`PARKING_PAY_MIN_MINUTES_LEFT` хв (5), до суми додається наступна година, а виїзд переноситься на годину
пізніше: о 15:56 - 100 ₴ і «виїзд до 17:00» замість 60 ₴ до 16:00 (нічна година - за нічною ціною).
Відповідь має `includesNextHour: true` і рядок наступної години в `breakdown`; те саме показують
`session.payNow` у героя і `payNow` / `includesNextHour` у `POST /parking/quote`. `0` вимикає правило.

**Платіж і спроби.** Ключ платежу `parking:<sessionId>:<paidUntilIso>` - одна логічна оплата на сесію і
оплачений період. `PAYMENTS_PORT.createPayment` повертає наявну спробу, лише якщо вона відкрита
(`created | pending`) або оплачена; після відхиленої картки, скасування чи простроченого checkout
створюється нова спроба `<ключ>:a2`, `:a3`, ... (у межах тієї ж години), і кожна спроба має власний
`ParkingPaymentLink`. Платіж створюється без транзакції parking: payments комітить рядок у власній
короткій транзакції, кличе провайдера поза транзакцією і зберігає checkout; зв'язок пишеться після цього
(`paidUntil` - виїзд, який купує платіж). `meta = { sessionId, paidUntil, plate, plateDisplay,
providerRef, includesNextHour }` (номер і «виїзд до» потрібні екрану квитанції в payments).

**`payment.succeeded`** (черга `parking-events`). Рішення приймається один раз на платіж під блокуванням
рядка сесії (`SELECT ... FOR UPDATE`) і записується в `ParkingPaymentLink.outcome`:

| Ситуація | `outcome` | Дія |
| --- | --- | --- |
| сесія активна, ця година ще не оплачена іншою спробою | `applied` | сесія оплачена до `paidUntil` (монотонно), сума - з неповернутих платежів, `registerPayment` в операторі (`registeredAt`), `parking.session.paid` |
| сесія вже закрита (`closed`, `closed_free`) | `refund_queued` | `PAYMENTS_PORT.requestRefund` (автоматичне повернення), подія `parking.payment.ops_alert` (`alert: refund_queued`), запис аудиту, error-лог |
| ту саму годину вже оплатила інша спроба (`already_paid`) | `refund_queued` | те саме |
| сесію не знайдено | - | повернення + ops alert без зв'язку |
| сесія `closed_unpaid` («Я вже виїхав» із боргом) | `alerted` | гроші лишаються (покривають спірну суму), `parking.payment.ops_alert` з `alert: manual_review` для звірки оператором |

Пізній успіх (`late: true`: провайдер списав гроші після того, як платіж прострочився, відхилився чи
скасувався) обробляється тими самими правилами: якщо сесія може його використати - застосовується,
інакше - повернення й alert. Повторна доставка нічого не змінює (alert не дублюється, повернення
ідемпотентне за платежем). Якщо оператор не прийняв реєстрацію, сесія все одно позначається
оплаченою, а помилка прокидається далі.

**Довга політика повторів.** Споживач `payment.succeeded` не обмежується 3 спробами outbox: при помилці
задача повертається в delayed (`moveToDelayed` + `DelayedError`, спроби BullMQ не витрачаються) з
затримкою 30 с, 1, 2, 4, 8, 16 хв, далі кожні 30 хв - 40 повторів, близько 17 год (`jobs/long-retry.ts`).

**Sweep.** Задача `payments-sweep` на черзі `parking-sync` кожні 5 хв (`parking-payments-sweep`) бере
зв'язки останніх 48 год, старші за 2 хв: без рішення, `applied` без `registeredAt`, `refund_queued` без
підтвердження запиту. Для оплачених платежів (через `PAYMENTS_PORT.getPayments`) повторює
`applyPaymentSucceeded` - перереєструє в операторі, застосує загублену подію або повторить запит
повернення. Заодно видаляє записи `parking_webhook_logs`, старші за 30 днів.

## Інформаційний режим

Таймер без оператора (завжди доступний у Релізі 1, вимикається прапорцем `parking.info_mode`):
`POST /parking/info/sessions { zone, enteredAt }` (не в майбутньому, не давніше за TTL, один активний
таймер), `POST /parking/info/sessions/:id/paid-at-paymat { paidUntil? }` (типово - кінець поточної
години), `POST /parking/info/sessions/:id/exit`, виправлення запущеного таймера
`PATCH /parking/info/sessions/:id { enteredAt?, zone? }` (ті самі межі, що й на старті; в'їзд має лишитися
раніше за «оплачено до» з паркомата) і `DELETE /parking/info/sessions/:id` (помилковий таймер видаляється
повністю, в історії не лишається; і активний, і завершений). Таймер підхоплює основне авто учасника. Суми
орієнтовні (`stayTotalKopecks`), `amountPaidKopecks` лишається 0 (оплата була поза застосунком).
Події outbox для таймерів типово не публікуються: нагадування інфо-режиму плануються на пристрої
(дизайн-бриф 4.2-4.3); `PARKING_INFO_TIMER_EVENTS=true` вмикає ті самі події, що й для сесій оператора.

## Повітряна тривога

Правило оператора: під час тривоги в'їзд закрито, виїзд безкоштовний у перші 30 хв. Джерело в Релізі 1
- прапорець `FEATURE_FLAG_KEYS.parkingAirRaid` (`parking.air_raid`, seed створює його вимкненим), який
вмикає черговий (`payload.startedAt` ISO, інакше момент зміни прапорця; `payload.freeExitMinutes`
перекриває `PARKING_AIR_RAID_FREE_EXIT_MINUTES`; тип payload - `ParkingAirRaidFlagPayload`). Виїзд у вікні,
коли щось було до сплати, закривається як `closed_free` з причиною `air_raid` (для сесій оператора,
таймерів і «Я вже виїхав»). Герой показує банер `air_raid` і `freeExitUntil` («Вільний виїзд до HH:MM»).
Адміністратор може закрити сесію безкоштовно вручну: `POST /admin/parking/sessions/:id/close-free`
(`privilege` або `air_raid`, з аудитом).

## Ендпоїнти (префікс `/api/v1`)

| Метод і шлях | Доступ | Що робить |
| --- | --- | --- |
| `GET /parking/vehicles` | учасник | мої авто, основне першим |
| `POST /parking/vehicles {plate, label?, makeDefault?}` | учасник | додати авто (з назвою; одразу основне) |
| `DELETE /parking/vehicles/:id` | учасник | видалити (не під час активної сесії) |
| `POST /parking/vehicles/:id/verify {talonCode \| paymatCode}` | учасник | верифікація (10/год з IP, 5/24 год на авто) |
| `POST /parking/vehicles/:id/default` | учасник | зробити основним |
| `GET /parking/session` | учасник | герой F0-F7 / I0-I4 |
| `POST /parking/sessions/claim {talonCode}` | учасник, `Idempotency-Key` | заявити сесію талоном (10/год), відповідь - герой |
| `POST /parking/session/:id/pay` | учасник, `Idempotency-Key` | оплата суми до сплати (`includesNextHour` в кінці години) |
| `POST /parking/session/:id/left` | учасник | «Я вже виїхав» |
| `POST /parking/session/:id/still-here` | учасник | F7 «Так, я тут», відповідь - герой |
| `POST /parking/session/:id/dispute {reason, comment?}` | учасник | F2 «Це не моє авто» / сума / шлагбаум, відповідь - герой |
| `GET /parking/history?cursor=&limit=&from=&to=` | учасник | історія, нові першими; `paidVia` (`app \| paymat \| free \| none`), `paymentIds`, `disputed` |
| `GET /parking/history/summary?month=YYYY-MM` | учасник | місяць за Києвом: `visits`, `totalPaidKopecks`, `totalDurationMinutes` (без оскаржених) |
| `GET /parking/tariff` | публічний | активний тариф + рядки для S06 |
| `POST /parking/quote {enteredAt, now?, paidUntil?}` | публічний | калькулятор (до 7 діб), `payNow` і `includesNextHour` |
| `POST /parking/info/sessions {zone, enteredAt}` | учасник | старт таймера |
| `PATCH /parking/info/sessions/:id {enteredAt?, zone?}` | учасник | виправити таймер |
| `DELETE /parking/info/sessions/:id` | учасник | видалити помилковий таймер без історії (204) |
| `POST /parking/info/sessions/:id/paid-at-paymat {paidUntil?}` | учасник | оплатив у паркоматі |
| `POST /parking/info/sessions/:id/exit` | учасник | виїхав |
| `POST /webhooks/parking/:provider` | публічний, підпис | події оператора (дедуплікація за `eventId`) |
| `GET /admin/parking/tariffs`, `GET /admin/parking/tariffs/:version`, `POST /admin/parking/tariffs` | admin: manager | версії тарифу (створення з аудитом) |
| `GET /admin/parking/sessions?status=&plate=&userId=&disputed=` | admin: manager, support | сесії (`disputed=true` - оскаржені) |
| `POST /admin/parking/sessions/:id/close-free {reason, note?}` | admin: manager, support | закрити як `closed_free` (аудит) |

## Черги та події

- `parking-sync`: розклад `parking-sync-every-minute`, кожні `PARKING_SYNC_EVERY_MS` (60 с). Логіка -
  `jobs/parking-sync.job.ts`: активні сесії оператора (лише номери учасників і вже збережені сесії),
  звірка збережених активних сесій, яких оператор більше не показує (виїзд за `getSessionByRef`,
  невідомі - закриття `timeout` після `PARKING_SESSION_TTL_HOURS`), такт таймерів інфо-режиму.
  Недоступний оператор не валить задачу (`providerAvailable: false`), одна сесія з помилкою не
  зупиняє пакет. На тій самій черзі - `payments-sweep` кожні 5 хв (розклад
  `parking-payments-sweep`, див. «Оплата»).
- `parking-events` (споживач outbox): `payment.succeeded` (див. «Оплата», довга політика повторів) і
  `user.deleted` (див. «Видалення акаунта»).
- Також публікує `parking.session.disputed` (споживає notifications) і `parking.payment.ops_alert`
  (лише аудит: `src/common/outbox/audit-only-events.ts`; дублюється записом `AuditLog`
  `parking_payment.ops_alert` з `entityType = payment` і error-логом).
- Публікує (outbox, лише для сесій з власником): `parking.session.opened`, `parking.session.payable`,
  `parking.session.paid`, `parking.session.overstay`, `parking.session.closed`,
  `parking.vehicle.verified`, а також нагадування з каталогу `events.ts`
  (`PARKING_EVENTS.sessionFreeEnding|sessionExitSoon|sessionStillInside`, payload
  `ParkingSessionReminderPayload`): `parking.session.free_ending` (за 5 хв до кінця безкоштовного
  часу), `parking.session.exit_soon` (за 10 хв до `paidUntil`), `parking.session.still_inside` (F7).
  Нагадування спрацьовують рівно один раз без окремої колонки: подія публікується в той такт,
  інтервал якого (`lastSyncedAt` попереднього такту, зараз] містить момент нагадування. Споживає їх
  модуль notifications (черга `notifications-events`, тексти дизайн-брифу 4.1); власного маршруту
  на нагадування parking більше не реєструє.

## Видалення акаунта (`user.deleted`)

`ParkingErasureService.eraseUser` (ідемпотентно, одна транзакція):

- авто учасника (живі й раніше видалені): `deletedAt` (наявне значення зберігається),
  `isDefault = false`, номер і `plateDisplay` замінюються заглушкою `erased-<9 hex id>` (16 символів,
  малі літери й дефіс - ніколи не збігається з нормалізованим номером, унікальна для авто, частковий
  унікальний індекс не порушується);
- закриті сесії учасника: `plate = null`, `vehicleId = null`; анонімізований `userId`, час і суми
  лишаються (історія й прив'язки платежів анонімного власника, як у леджері);
- активні сесії учасника відв'язуються від акаунта (`userId`, `vehicleId` = null): нічого не
  показується й не публікується для видаленого акаунта. Сесія оператора зберігає номер і факти
  (авто фізично на паркінгу, оператор і далі звітує про нього; рядок поводиться як сесія
  неверифікованого номера й закривається виїздом або через `PARKING_SESSION_TTL_HOURS`). Таймер
  інфо-режиму належить лише учаснику, тому втрачає й номер і закривається за TTL. `lastSyncedAt`
  оновлюється, щоб паралельний такт синхронізації зі старою копією рядка програв compare-and-set і
  не прив'язав сесію назад;
- сесії, збережені без власника (неверифіковані номери), атрибутувати неможливо - вони лишаються.

## Змінні середовища

| Змінна | Типово | Опис |
| --- | --- | --- |
| `PARKING_PROVIDER` | `emulator` | `emulator` або `vendor` (заглушка, усе 503) |
| `PARKING_EMULATOR_SCENARIO` | `payable` | `free`, `payable`, `paid`, `closed` |
| `PARKING_EMULATOR_ANCHOR` | `today` | `today` (як seed) або `now` (зсув до моменту сценарію) |
| `PARKING_EMULATOR_PLATE` | `AC1234BC` | демо-номер емулятора |
| `PARKING_VENDOR_BASE_URL`, `PARKING_VENDOR_API_KEY` | - | для майбутнього адаптера оператора |
| `PARKING_WEBHOOK_SECRET` | dev-значення | HMAC для `X-Parking-Signature` |
| `PARKING_SYNC_EVERY_MS` | `60000` | інтервал `parking-sync` |
| `PARKING_SESSION_STALE_MS` | `60000` | коли GET перепитує оператора; також пауза після помилки оператора |
| `PARKING_UNVERIFIED_LOOKUPS_PER_HOUR` | `10` | квота неверифікованих номерів |
| `PARKING_MAX_VEHICLES` | `5` | авто на учасника |
| `PARKING_SESSION_TTL_HOURS` | `24` | закриття забутих таймерів і сесій, яких не знає оператор |
| `PARKING_INFO_MODE_DEFAULT` | `true` | інфо-режим, якщо рядка прапорця `parking.info_mode` немає |
| `PARKING_INFO_TIMER_EVENTS` | `false` | події outbox для таймерів інфо-режиму |
| `PARKING_FREE_ENDING_REMINDER_MINUTES` | `5` | нагадування про кінець безкоштовного часу |
| `PARKING_EXIT_REMINDER_MINUTES` | `10` | нагадування про виїзд |
| `PARKING_AIR_RAID_FREE_EXIT_MINUTES` | `30` | вікно безкоштовного виїзду під час тривоги |
| `PARKING_RECENT_CLOSED_HOURS` | `2` | скільки герой показує закриту сесію (F6 / I4) |
| `PARKING_PAYMENT_RETURN_URL` | - | deep link після оплати |
| `PARKING_PAY_MIN_MINUTES_LEFT` | `5` | менше хвилин до кінця години - оплата включає наступну годину (`0` вимикає) |

Константи (не змінні середовища): 10 заявок талоном на годину на учасника (`CLAIMS_PER_HOUR`),
5 спроб верифікації на авто за 24 год (`VERIFY_ATTEMPTS_PER_VEHICLE`), sweep кожні 5 хв за останні 48 год
(`PARKING_PAYMENTS_SWEEP_EVERY_MS`, `PAYMENT_SWEEP_WINDOW_HOURS`), довга політика повторів
`PAYMENT_SUCCEEDED_RETRY`.

## Тести

```bash
npx jest src/modules/parking                                   # юніт: домен, сервіси на фейках, задачі
npx jest --config test/jest-e2e.config.js --runInBand test/parking   # e2e: повний AppModule без БД
```

Сервісні тести збирають усі сервіси вручну (`testing/parking-harness.ts`): `FakePrisma`, `FakeClock`,
справжні `OutboxService`, `FeatureFlagsService`, `AuditService` поверх фейкового клієнта,
`FakePaymentsPort`, емулятор або `FakeParkingProvider`. Покрито: сценарії емулятора через усі стани
(F0-F7, I0-I4), нагадування, тривогу, квоту неверифікованих номерів, оплату і `payment.succeeded`
(зокрема збій реєстрації в операторі), інфо-режим, задачу синхронізації (обробник на фейках і
двогодинний прогін щохвилини на емуляторі), збереження `level`/`spot`, вебхуки (підпис сирого тіла,
дедуплікація за `eventId`), `user.deleted` (`ParkingErasureService`), OpenAPI-документ. Виправлення
рев'ю 2026-11-01 (`parking-payments.service.spec.ts`, `sessions.actions.spec.ts`, доменні
`pay-charge`/`history`, `long-retry`): повторна спроба після відхиленої/скасованої/простроченої оплати
в межах тієї ж години, пізній успіх (застосування або повернення + ops alert), відсутність транзакції
навколо `createPayment`, sweep і перереєстрація, кінець години, талон, «Так, я тут», «Це не моє авто»,
редагування й видалення таймера, платежі в сесії й історії, підсумок місяця, назва авто, квота
верифікації на авто.

## Обмеження та відкриті питання

- Формат і події реального оператора невідомі (дизайн-бриф розділ 9, п. 2): чи є вебхуки
  в'їзду/виїзду, від чого рахується оплачена година, формат талона і чи вміє оператор шукати сесію за
  талоном (`findSessionByTalon`), чи приймає реєстрацію оплати для вже закритої сесії.
- Правило тривоги трактується як «виїзд у перші 30 хв від початку тривоги безкоштовний»; потрібне
  підтвердження оператора. Джерело тривоги - прапорець чергового.
- `closed_unpaid` після «Я вже виїхав» - спірна сума без автосписання; оплата з застосунку, що прийшла
  після цього, не повертається, а йде в ops alert `manual_review` для звірки за рунбуком оператора.
- Сповіщення про автоматичне повернення: notifications перетворює `payment.refunded` паркінгового
  платежу на `payment_refunded` («Кошти за паркінг повернуто», закрито 01.11.2026). Окремого
  повідомлення в момент `refund_queued` немає: учасник дізнається, коли провайдер підтвердив повернення.
- `parking.payment.ops_alert` поки не має споживача (лише outbox, аудит і error-лог); канал для
  чергового (пошта, Slack) - відкрите питання.
- Оскаржена сесія лишається прив'язаною до учасника (оператор і далі звітує про номер); зняття
  оскарження - лише підтримкою вручну.

## English summary

Parking module: vehicles (normalised Latin plates, verification by talon or paymat code through the
provider port), sessions from the operator (emulator reproducing the canonical 14:00 / 14:30 / 60 UAH at
15:20 / paid until 16:00 / exit 15:52 timeline, vendor stub answering 503) or member-run info-mode
timers, a single write path with compare-and-set and outbox events, crossing-based reminders
(free ending in 5 min, exit in 10 min, still inside), the air-raid free-exit rule, unverified plates
limited to amount and paid period at 10 lookups per hour, payment through PAYMENTS_PORT with a
(session, paid hour) idempotency key and `payment.succeeded` marking the session paid, the
`parking-sync` job every 60 s, an operator webhook signed over the raw body bytes, operator
level/spot stored on the session row, `user.deleted` erasure of plates (vehicles masked and
soft-deleted, closed sessions scrubbed, active sessions detached), the air-raid flag
`FEATURE_FLAG_KEYS.parkingAirRaid`, reminder events from the outbox catalogue consumed by
notifications, admin tariff and session tools, and PARKING_PORT for other modules.

Review fixes (2026-11-01): a failed, cancelled or expired checkout can be retried within the same hour
(new payment attempt `<key>:a<n>`, one link per attempt); the payment is created outside any parking
transaction and linked afterwards; `payment.succeeded` decides once per payment under the session row
lock (applied, or refunded through `PAYMENTS_PORT.requestRefund` with a `parking.payment.ops_alert` when
the session is closed or the hour is already paid, kept with a manual-review alert for `closed_unpaid`),
runs under a long retry policy (~17 h) and is backed by a 5-minute sweep that re-registers paid payments
the operator has not accepted (`registeredAt`); paying with less than `PARKING_PAY_MIN_MINUTES_LEFT`
minutes left includes the next hour (`includesNextHour`); operator webhooks are de-duplicated by event
id; talon claim (`findSessionByTalon`, `POST /parking/sessions/claim`), F7 «Так, я тут», F2 dispute,
info-timer edit and discard, session payments, history `paidVia`/`paymentIds`/`from`/`to` and a monthly
summary, vehicle `label`/`makeDefault` and a per-vehicle verification cap.
