# Модуль payments

Платежі через змінний провайдер (порт `PaymentProviderPort`, у розробці - мок), підписані
ідемпотентні вебхуки, повернення коштів, хук фіскалізації і щогодинне звіряння з провайдером.
Надає `PAYMENTS_PORT` (`PaymentsService`: `createPayment`, `getPayment`, `getPayments`,
`getPaymentByIdempotencyKey`, `requestRefund`) для parking і admin. Залежить лише від спільного шару
(листок графа модулів). Споживає подію `user.deleted` (черга `payments-events`).

English summary: payments through a pluggable provider port (mock in development), signed and
idempotent webhooks, refunds, a fiscalisation hook and hourly reconciliation. Provides PAYMENTS_PORT.
Review fixes (2026-11-01): a logical key may have several attempts (`<key>:a<n>`; open or paid ones are
reused, closed unpaid ones are followed by a new attempt); the attempt row is committed in its own
transaction before the provider call (never inside the caller's transaction); reconciliation cancels
the checkout at the provider before expiring locally, and a success after failed/cancelled/expired is
applied as a late success (`payment.succeeded` with `late: true`); refunds are reserved under the row
lock and resumed with the same provider idempotency key; `requestRefund` queues automatic refunds;
strict (real) adapters require amount and currency on success and reject stale timestamped webhooks;
`PaymentDto` carries `displayNumber`, `merchantName`, `parking` and a signed `operatorQrPayload`.
E-mailing receipts is out of scope: the app shares `fiscalReceiptUrl`.

## Модель (`prisma/schema/payments.prisma`)

| Модель              | Ключові поля                                                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `Payment`           | `userId`, `purpose` (`parking`/`other`), `amountKopecks` (> 0, CHECK), `currency` UAH, `provider`, `providerRef`, `status`, `idempotencyKey` (унікальний), `checkoutUrl`, `fiscalReceiptUrl`, `failureCode`, `refundedKopecks`, `paidAt`, `meta` |
| `PaymentWebhookLog` | `provider`, `externalId` (унікальні разом), `paymentId`, `payload`, `receivedAt`, `processedAt`, `result`                         |

`meta`: верхній рівень - бізнес-контекст викликача (`{ sessionId, paidUntil, plate, plateDisplay }`
для паркінгу), він же йде в події outbox; службові дані модуля лежать під ключем `_internal` і назовні
не віддаються: опис, `returnUrl`, `checkoutExpiresAt`, `baseKey` / `attempt` (логічний ключ і номер
спроби), `refunds` (історія повернень), `pendingRefund` (резерв повернення: `requestId`, `state`
`reserved | failed | awaiting_provider`, сума), `autoRefund` (автоматичне повернення на запит модуля
призначення: `queued | done | skipped`, причина, джерело), `fiscalization`, `lateSuccess` (з якого
статусу прийшов пізній успіх), `lastEvent`.

## Машина станів (`domain/state-machine.ts`)

```
created -> pending (3DS/гаманець) -> succeeded -> fiscalized -> refunded | partially_refunded
        \-> succeeded (гаманець без 3DS)      \-> partially_refunded | refunded (без фіскалізації)
created | pending -> failed | cancelled | expired
failed | cancelled | expired -> succeeded (пізній успіх, лише з події провайдера)
partially_refunded -> partially_refunded (ще одне часткове) | refunded
```

Закриті: `failed`, `cancelled`, `expired`, `refunded`; з перших трьох можливий лише пізній успіх
(провайдер списав гроші після того, як ми закрили платіж: звіряння прострочило його в гонці з
покупцем, провайдер скасував відмову). Гроші списані - платіж іде за ними: перехід у `succeeded`,
`payment.succeeded` з `late: true`, `_internal.lateSuccess`; що робити з платежем, вирішує модуль
призначення (parking застосовує або повертає, див. його README). Пізній успіх з іншою сумою чи валютою не
застосовується. `refunded` фінальний остаточно. Рішення щодо події провайдера - чиста функція
`applyProviderEvent` (дублікати, порядок доставки, конфлікти, розбіжність суми чи валюти, кумулятивні
повернення); кожна зміна статусу - під `SELECT ... FOR UPDATE` рядка платежу разом із подією outbox
(`payment.succeeded|failed|cancelled|expired|refunded|fiscalized`; `payment.created` при створенні).

## Створення платежу і спроби (`createPayment`)

`idempotencyKey` - логічна операція (для паркінгу `parking:<sessionId>:<paidUntilIso>`, до 240 символів).
Спроба 1 має сам ключ, спроба n - `<ключ>:a<n>` (до 50 спроб). Наявна спроба повертається, якщо вона
відкрита (`created | pending`) або оплачена (`succeeded | fiscalized | partially_refunded`); після
`failed | cancelled | expired | refunded` створюється наступна спроба - учасник може повторити оплату
після відхиленої картки в межах тієї ж години. Відкрита спроба, чий checkout за словами провайдера вже
прострочений (`checkoutExpiresAt`), спершу звіряється з провайдером (скасування, див. нижче).

Провайдер ніколи не викликається всередині транзакції БД (і транзакцію викликача порт більше не
приймає): (1) рядок спроби `created` без checkout комітиться у власній короткій транзакції разом із
`payment.created`; (2) `createCheckout` поза транзакцією; (3) під блокуванням рядка зберігаються
`providerRef`, `checkoutUrl`, `checkoutExpiresAt`. Збій провайдера закриває спробу як `cancelled` з
`failureCode = checkout_create_failed` (502 викликачу, наступне натискання - нова спроба). Рядок без
checkout, старший за 60 с (запит упав між кроками), закривається як `cancelled`
(`checkout_not_created`) при наступній спробі або звірянні. Гонка двох викликів за ту саму спробу
(P2002 унікального ключа): програвший перечитує рядок переможця і до ~2 с чекає, поки той збереже
checkout, а закриту спробу пропускає. Модуль призначення пише свій зв'язок після повернення.

## Вебхуки

`POST /webhooks/payments/:provider` (публічний, ліміт 600 запитів/хв):

1. Адаптер провайдера перевіряє підпис до будь-якої роботи з БД (`PC_PAYMENT_WEBHOOK_SIGNATURE`, 401;
   кривий payload - `PC_PAYMENT_WEBHOOK_MALFORMED`, 400). Підпис рахується від точних байтів тіла:
   контролер передає `request.rawBody` (`rawBody: true` у `NestFactory.create`, `src/main.ts`), тож
   переформатований JSON не пройде. Мок: заголовок `X-Mock-Signature` = HMAC-SHA256 (hex) сирого тіла
   з `PAYMENTS_MOCK_WEBHOOK_SECRET`, порівняння за сталий час. Лише для викликів усередині процесу без
   сирого тіла адаптер підписує канонічний JSON.
   Строгість реальних еквайрів (усі адаптери, крім мока; `PaymentProviderPort.strictWebhooks`):
   повідомлення про успіх без суми або валюти - `400 PC_PAYMENT_WEBHOOK_MALFORMED`; якщо провайдер
   передає час відправки (`occurredAt`), повідомлення старше (або з майбутнього) понад
   `PAYMENTS_WEBHOOK_MAX_AGE_SECONDS` (600) - `400 PC_PAYMENT_WEBHOOK_STALE` (захист від повтору).
   Обидві перевірки - до будь-якої роботи з БД (`domain/webhook-policy.ts`). Мок нестрогий
   (для тестів строгого шляху - опція `strictWebhooks` і поле `sent_at`).
2. Ідемпотентність за зовнішнім id: `(provider, externalId)` унікальний у `payment_webhook_logs`;
   повтор повертає `result: duplicate` без побічних ефектів, паралельний дубль ловиться унікальним
   індексом (теж `duplicate`).
3. Рядок журналу, перехід статусу і подія outbox пишуться в одній транзакції; після коміту для
   `succeeded` ставиться задача фіскалізації.
4. Невідомий платіж - 404, щоб провайдер повторив пізніше (рядок платежу ще може комітитись).

## Мок-провайдер у розробці

`MockPaymentProvider` тримає checkout-и в пам'яті процесу API і повертає
`checkoutUrl = PAYMENTS_MOCK_CHECKOUT_BASE_URL/<providerRef>` (типово
`http://localhost:3000/api/v1/mock-checkout/mock_<paymentId>`). Цю адресу обслуговує
`MockCheckoutController` (лише не в production і лише за `PAYMENTS_PROVIDER=mock`, інакше 404):

- `GET /mock-checkout/:providerRef` - HTML-сторінка з кнопками «Оплатити», «Картку відхилено», «Скасувати»;
- `POST /mock-checkout/:providerRef/complete {outcome, failureCode?}` - завершує checkout і доставляє
  підписаний вебхук через той самий `PaymentWebhooksService` (тіло серіалізується один раз, підпис
  рахується саме від цього рядка і він же передається як `rawBody`); повтор того самого результату -
  дубль.

Приклад (curl): створити платіж через parking (`POST /parking/session/:id/pay`), потім
`curl -X POST localhost:3000/api/v1/mock-checkout/mock_<id>/complete -H 'Content-Type: application/json' -d '{"outcome":"succeeded"}'`.
Після перезапуску API мок «забуває» checkout-и: звіряння переводить такі платежі в `expired`, як
справжній провайдер, що прибрав покинутий checkout. Мок також вміє `cancelCheckout` (відкритий checkout
стає `cancelled`, оплачений повертається як `final`) і пам'ятає повернення за ключем ідемпотентності
запиту (повтор не повертає гроші вдруге).

## Повернення коштів

`refund` (бек-офіс `POST /admin/payments/:id/refund` і автоматичні повернення) у три кроки, щоб гроші
ніколи не повернулися двічі:

1. під `SELECT ... FOR UPDATE` сума перевіряється (`planRefund`) і резервується в
   `_internal.pendingRefund` з `requestId` (`state: reserved`); поки резерв не завершено, інше повернення
   - `409 PC_PAYMENT_REFUND_IN_PROGRESS`;
2. провайдер викликається поза транзакцією з `requestId` як ключем ідемпотентності;
3. під блокуванням результат записується (перехід `partially_refunded | refunded`, історія, аудит,
   `payment.refunded`), або `state: awaiting_provider` для асинхронного провайдера (завершує вебхук
   `refunded`).

Остаточна відмова провайдера (`DomainError` адаптера) знімає резерв; транспортна помилка лишає його як
`failed` - наступний запит без іншої суми продовжує той самий `requestId` (провайдер не поверне вдруге).

Автоматичне повернення (`PAYMENTS_PORT.requestRefund({ paymentId, reason, source, amountKopecks? })`,
наприклад parking для оплати, яку сесія вже не може використати): один раз на платіж під блокуванням
пишеться `_internal.autoRefund` (`queued`) і аудит `payment.auto_refund_requested` (актор
`system: auto-refund:<source>`), після коміту ставиться задача `auto-refund` (черга `payments-reconcile`,
12 спроб, експоненційно від 1 хв). Задача виконує `refund` з `requestId = auto-refund:<paymentId>` і
позначає `autoRefund.state = done` (або `skipped`, якщо грошей уже немає). Повторний запит повертає
`already_queued`, платіж без списаних грошей - `not_refundable`. Щогодинне звіряння повторно ставить
задачі для запитів, що лишилися `queued`.

Фіскалізація: збій або пропуск фіскального адаптера записується в `_internal.fiscalization` під
блокуванням рядка зі злиттям `meta` (паралельний резерв повернення не затирається).

## Екран квитанції (`GET /payments/:id`)

`PaymentDto` має поля для екрана квитанції: `displayNumber` (короткий людський номер на зразок
`4F7K-2031`, похідний від id через SHA-256, без колонки; не унікальний за побудовою, повний id лишається
посиланням), `merchantName` (для паркінгу - оператор паркінгу ФОП з `PAYMENTS_PARKING_MERCHANT_NAME`,
інакше `PAYMENTS_MERCHANT_NAME`), `parking { plateDisplay, paidUntil, sessionId }` (з `meta` платежу) і
`operatorQrPayload` - підписаний QR для оператора лише для оплачених паркінгових платежів:
`PCP1.<paymentId>.<sessionId>.<paidUntilUnix>.<amountKopecks>.<sig>`, `sig` - перші 22 символи
base64url(HMAC-SHA256(`PAYMENTS_RECEIPT_QR_SECRET`, усе до нього)); перевірка - `verifyOperatorQr`.

Надсилання квитанції на e-mail - поза обсягом (рішення): застосунок ділиться `fiscalReceiptUrl`
(системне «Поділитися»).

## Ендпоїнти (префікс `/api/v1`)

| Метод і шлях                           | Доступ                               | Опис                                                                  |
| -------------------------------------- | ------------------------------------ | --------------------------------------------------------------------- |
| `GET /payments`                        | member                               | мої платежі, `?status=&cursor=&limit=`                                |
| `GET /payments/:id`                    | member                               | статус і екран квитанції (застосунок опитує після checkout); чужий - 404 |
| `POST /webhooks/payments/:provider`    | публічний, підпис провайдера         | див. вище                                                             |
| `GET /admin/payments`                  | admin: owner, manager, support       | фільтри `userId`, `status`, `provider`, `purpose`, `from`, `to`       |
| `GET /admin/payments/:id`              | admin: owner, manager, support       | платіж, службова частина `meta`, журнал вебхуків                      |
| `POST /admin/payments/:id/refund`      | admin: owner, manager                | повне або часткове повернення (`Idempotency-Key`), резерв під блокуванням, аудит |
| `POST /admin/payments/:id/reconcile`   | admin: owner, manager, support       | негайне звіряння з провайдером («оплатив, а шлагбаум не відкрився»): скасування checkout у провайдера перед простроченням, аудит |
| `GET /mock-checkout/:providerRef`      | публічний, лише dev                  | сторінка мок-оплати                                                   |
| `POST /mock-checkout/:providerRef/complete` | публічний, лише dev             | завершити мок-оплату                                                  |

Створення платежу HTTP-ендпоїнта не має: його ініціює модуль призначення через `PAYMENTS_PORT`
(`createPayment` ідемпотентний за логічним `idempotencyKey`: відкрита чи оплачена спроба повертається,
після невдалої - нова спроба, див. «Створення платежу і спроби»).

## Задачі воркера

| Черга                | Задача      | Розклад   | Що робить                                                                                                  |
| -------------------- | ----------- | --------- | ---------------------------------------------------------------------------------------------------------- |
| `payments-reconcile` | `reconcile` | щогодини  | відкриті платежі старші за `PAYMENTS_PENDING_TIMEOUT_MINUTES` (20): запит статусу у провайдера, термінальна відповідь застосовується; «досі pending» або «не знаю» - спершу `cancelCheckout` у провайдера, і лише коли провайдер підтвердив скасування або не знає платежу - `expired` (якщо провайдер каже, що вже оплачено, - застосовується успіх); спроба без checkout (`checkout_not_created`) - `expired` без провайдера; збій провайдера - чекаємо наступного запуску; дочергування фіскалізації і автоматичних повернень у стані `queued` |
| `payments-reconcile` | `fiscalize` | після `payment.succeeded` | хук фіскалізації (`none` - пропуск, `mock` - фейковий чек), `succeeded -> fiscalized`          |
| `payments-reconcile` | `auto-refund` | `PAYMENTS_PORT.requestRefund` (12 спроб, від 1 хв) | автоматичне повернення одного платежу, див. «Повернення коштів» |
| `payments-events`    | `user.deleted` | outbox (маршрут у `PaymentsModule.onModuleInit`) | див. «Видалення акаунта» |

Логіка - чисті функції `runPaymentsReconcile` / `runFiscalizeJob` / `runAutoRefundJob` (`jobs/payments-reconcile.job.ts`)
і `handlePaymentsEvent` (`jobs/payments-events.handler.ts`), процесори лише з'єднують.

## Видалення акаунта (`user.deleted`)

Платежі - фінансові записи, тому лишаються з сумами, статусами, `providerRef` і анонімізованим
власником. `PaymentsErasureService.eraseUser` (ідемпотентно, одна транзакція) прибирає з `meta`
платежів учасника персональні дані (чиста функція `erasePersonalMeta`, `domain/erasure.ts`):
ключі `plate`, `plateDisplay`, `phone`, `email`, `name`, `firstName`, `lastName`, `fullName`,
`birthDate` на верхньому рівні й у `_internal`, а внутрішній опис checkout (для паркінгу містить
номер авто) замінюється нейтральним «Паркінг Порт City» / «Платіж Порт City». Журнал вебхуків
(`payment_webhook_logs.payload`) персональних полів учасника не містить і не змінюється.

## Змінні середовища (секція `payments`, `payments.config.ts`)

| Змінна                              | Типово                                       | Опис                                                         |
| ----------------------------------- | -------------------------------------------- | ------------------------------------------------------------ |
| `PAYMENTS_PROVIDER`                 | `mock`                                       | адаптер для нових платежів; `mock` заборонено в production    |
| `PAYMENTS_MOCK_WEBHOOK_SECRET`      | dev-значення                                 | секрет HMAC мок-вебхуків; dev-значення заборонено в production |
| `PAYMENTS_MOCK_CHECKOUT_BASE_URL`   | `http://localhost:3000/api/v1/mock-checkout` | база `checkoutUrl` мок-провайдера                            |
| `PAYMENTS_RETURN_URL`               | `portcity://payments/return`                 | deep link після checkout, якщо викликач не дав свого         |
| `PAYMENTS_PENDING_TIMEOUT_MINUTES`  | `20`                                         | вік відкритого платежу для звіряння                          |
| `PAYMENTS_RECONCILE_BATCH`          | `200`                                        | скільки платежів перевіряє один запуск                        |
| `PAYMENTS_FISCALIZATION`            | `none`                                       | `none` або `mock`                                            |
| `PAYMENTS_MOCK_FISCAL_BASE_URL`     | `http://localhost:3000/mock-fiscal`          | база фейкового URL фіскального чека                          |
| `PAYMENTS_WEBHOOK_MAX_AGE_SECONDS`  | `600`                                        | строгі (реальні) адаптери відхиляють старші повідомлення з часом відправки |
| `PAYMENTS_MERCHANT_NAME`            | `ТРЦ «Порт City»`                            | отримувач на квитанції непаркінгових платежів                |
| `PAYMENTS_PARKING_MERCHANT_NAME`    | `Оператор паркінгу ТРЦ «Порт City» (ФОП)`     | отримувач на квитанції паркінгу (ФОП оператора; замінити реальною назвою) |
| `PAYMENTS_RECEIPT_QR_SECRET`        | dev-значення                                 | HMAC `operatorQrPayload`; dev-значення заборонено в production |

## Тести

`npx jest src/modules/payments`: домен (машина станів з пізнім успіхом, події провайдера, повернення,
звіряння зі скасуванням, спроби, політика вебхуків, квитанція, валідація), мок-провайдер, реєстр,
конфіг, маппер, задачі, сервіси (`PaymentsService`, `PaymentWebhooksService`, `MockCheckoutService`,
`PaymentsErasureService`) на in-memory Prisma (`test/payments/support/payments-harness.ts`, сервіс без
реальних пауз - `TestPaymentsService`) зі справжнім мок-провайдером, підпис сирого тіла, обробник
`payments-events` і `erasePersonalMeta`. Відтворено й закрито знахідки рев'ю: повторна оплата після
відхиленої спроби (нова спроба `:a2`), успіх після простроченого звіряння (скасування в провайдера,
`late: true`), відсутність транзакції навколо провайдера (рядок закомічено до виклику), гонка P2002,
зависла спроба, резерв повернення і продовження з тим самим ключем, автоматичне повернення, злиття meta
при збої фіскалізації, строгі вебхуки. E2E (`test/payments`): маршрути, guards, підпис вебхука над
точними байтами, маршрут `user.deleted -> payments-events`, поля квитанції в OpenAPI.

## Відкриті питання

1. Реальний еквайр (LiqPay, monobank, WayForPay, Fondy, Portmone) обирається на Discovery; кожен
   адаптер - окремий `PaymentProviderPort` у `createProviderRegistry`. Сире тіло запиту вже доступне
   адаптерам (`ProviderWebhookRequest.rawBody`, `rawBody: true` у `src/main.ts`).
2. Хто фіскалізує (провайдер автоматично чи ПРРО Checkbox / Вчасно.Каса) - вирішує замовник;
   до того `PAYMENTS_FISCALIZATION=none`.
3. Стан мок-провайдера живе в пам'яті процесу API; воркер його не бачить, тому звіряння в розробці
   закриває незавершені мок-платежі як `expired`. Для прод-провайдерів це не стосується.
4. Реальні адаптери мають реалізувати `cancelCheckout` (скасування hosted checkout) та ідемпотентні
   повернення за ключем запиту; якщо еквайр цього не вміє, звіряння лишатиме платіж відкритим до
   підтвердження, а повернення робитиме за рунбуком.
5. Реальна назва ФОП оператора паркінгу для `PAYMENTS_PARKING_MERCHANT_NAME` - від замовника.

Закрито під час консолідації рецензії (01.11.2026): `payment.refunded` більше не «лише аудит» -
notifications повідомляє учасника про повернення паркінгового платежу (вид `payment_refunded`).

Закрито під час інтеграції (2026-11-01): змінні модуля перенесено в `.env.example`; спільна схема
теж відхиляє `PAYMENTS_PROVIDER=mock` у production.
