# Модуль notifications

Внутрішня скринька повідомлень, налаштування за видами, push через порт (заглушка або FCM HTTP v1),
e-mail через `MailPort` (листи підтримці про звернення), споживачі подій outbox і облік доставок push. Надає `NOTIFICATIONS_PORT`
(`NotificationsService`: `notify`, `countUnread`) для admin і задач, що вже знають адресата.
Залежить від identity (`IDENTITY_PORT`: користувач, згоди, push-пристрої) і promos (`PROMOS_PORT`:
назва і час події для нагадування про квиток).

English summary: in-app inbox, per-kind preferences, push port (stub / FCM HTTP v1), mail port
(log adapter; SMTP is a documented TODO) for support desk e-mails, outbox consumers and push delivery
records. Provides NOTIFICATIONS_PORT.

## Модель (`prisma/schema/notifications.prisma`)

| Модель                   | Ключові поля                                                                                                                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Notification`           | `userId`, `kind` (реєстр `NOTIFICATION_KINDS`), `title` (до 200), `body`, `data` (deep link), `channel` (`inapp`/`push`/`both`), `sentAt`, `readAt`, `dedupeKey` (унікальний разом з `userId`) |
| `PushDelivery`           | `notificationId`, `deviceId`, `provider` (`stub`/`fcm`), `status`, `error`, `attempts`, `sentAt` - один рядок на пару повідомлення-пристрій                                                    |
| `NotificationPreference` | `(userId, kind)`, `enabled`; відсутній рядок - увімкнено                                                                                                                                       |

`notify()` - єдиний шлях запису: перевіряє вид, статус користувача (`active`), згоду `marketing` для
маркетингових видів і налаштування учасника (`domain/delivery-policy.ts`), зберігає рядок і в тій самій
транзакції публікує `notification.created`. Ідемпотентність за `dedupeKey` (споживачі передають
`outbox:<eventId>`, нагадування - `reminder:...`): ключ лежить у колонці `notifications.dedupe_key` з
унікальним індексом `(user_id, dedupe_key)`; повтор повертає наявне повідомлення. Вставка з ключем іде як
`createMany(..., skipDuplicates)` (`INSERT ... ON CONFLICT DO NOTHING`), тож паралельна доставка тієї самої
події не створює дубль і не обриває транзакцію викликача; програвша сторона читає рядок-переможця.
Службові види (платежі, акаунт, системні) вимкнути не можна (`PC_NOTIFICATION_PREFERENCE_LOCKED`, 422).

## Машини станів

```
Notification:  створено (sentAt = null для push/both, = now для inapp) -> sentAt після задачі push ; readAt - коли прочитано
PushDelivery:  queued -> sent | failed | skipped ; failed -> sent | failed | skipped (поки attempts < PUSH_MAX_ATTEMPTS)
```

`skipped` - спроба не мала сенсу (провайдер не налаштований); `failed` з `retryable` - задача
кидає `PushRetryError`, BullMQ повторює, і надсилаються лише пристрої без `sent`. `sentAt` повідомлення
ставиться, коли пішов хоча б один push або пушити не було кому. Чисті функції - `domain/push-delivery.machine.ts`,
`domain/delivery-policy.ts` (табличні тести).

## Ендпоїнти (префікс `/api/v1`)

| Метод і шлях                      | Доступ                                 | Опис                                                            |
| --------------------------------- | -------------------------------------- | --------------------------------------------------------------- |
| `GET /notifications`              | member                                 | мої повідомлення, нові першими, `?unread=&kind=&cursor=&limit=` |
| `GET /notifications/unread-count` | member                                 | лічильник для бейджа                                            |
| `POST /notifications/:id/read`    | member                                 | позначити прочитаним (ідемпотентно); чуже - 404                 |
| `POST /notifications/read-all`    | member                                 | позначити всі прочитаними, повертає кількість                   |
| `GET /notifications/preferences`  | member                                 | усі види з категорією, `enabled`, `locked`                      |
| `PUT /notifications/preferences`  | member                                 | `{ items: [{ kind, enabled }] }`, часткове оновлення            |
| `POST /admin/notifications`       | admin: manager, support (owner завжди) | надіслати учаснику (повідомлення і аудит в одній транзакції)    |
| `GET /admin/notifications`        | admin: manager, support, moderator     | скринька учасника `?userId=`                                    |
| `GET /admin/notifications/:id`    | admin: manager, support, moderator     | повідомлення з рядками `PushDelivery`                           |

## Події та задачі воркера

| Черга                  | Задача (ім'я = тип події)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Що робить                                                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `notifications-events` | outbox: `receipt.needs_moderation`, `receipt.rejected`, `receipt.credited`, `points.released`, `points.expiring`, `points.expired`, `adjustment.applied`, `voucher.issued`, `voucher.redeemed`, `voucher.cancelled`, `voucher.expired`, `event.registered`, `event.registration_cancelled`, `event.cancelled`, `event.published`, `promo.published`, `parking.session.opened`, `parking.session.free_ending`, `parking.session.payable`, `parking.session.paid`, `parking.session.exit_soon`, `parking.session.overstay`, `parking.session.still_inside`, `parking.session.closed`, `parking.session.disputed`, `payment.succeeded`, `payment.failed`, `payment.refunded`, `user.deletion_requested`, `user.deletion_cancelled`, `user.deleted`, `support.request_created` | `mapOutboxEvent` (чиста функція) перетворює подію на дії: повідомлення, планування або скасування нагадування, маркетингова розсилка, очищення даних видаленого учасника |
| `notifications-events` | `reminder.ticket` (відкладена, за 24 год до події)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | нагадування про квиток, якщо подія не скасована і ще не почалась                                                                                                         |
| `notifications-events` | `reminder.voucher_expiring` (за 24 год до `expiresAt`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | нагадування про ваучер; скасовується подіями `voucher.redeemed/cancelled/expired`                                                                                        |
| `notifications-push`   | `notification.created`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | push через `PushPort` на кожен пристрій з токеном, запис `PushDelivery`, `sentAt`                                                                                        |

Маршрути реєструються в `NotificationsModule.onModuleInit` (`jobs/routes.ts`). Логіка - чисті
функції `handleNotificationsEventJob` і `processPushJob` (юніт-тести), процесори лише підключають
сервіси. Нагадування мають стабільні id (`ticket-reminder-<registrationId>`,
`voucher-expiring-<voucherId>`), тож повторна доставка події нічого не дублює.

Свідомі рішення: `receipt.approved` не споживається (за ним іде `receipt.credited` з балами);
`payment.succeeded` для паркінгу покриває `parking.session.paid`; `voucher.expired` лише скасовує
нагадування (окремого виду немає).

**Повернення коштів за паркінг.** `payment.refunded` з `purpose = parking` -> `payment_refunded`
(«Кошти за паркінг повернуто»: сума, для часткового - «з <суми платежу>», номер авто з `meta`, «кошти
надійдуть на картку, якою ви платили; строк зарахування залежить від банку»; службовий вид, вимкнути не
можна). Головний випадок - автоматичне повернення parking (оплата прийшла після закриття сесії або ту
саму годину вже оплатила інша спроба), коли бек-офіс учасника не повідомляє; ручне повернення з
бек-офісу теж дає це повідомлення. Інші призначення платежів ігноруються.

**Події (афіша).** `event.registered` -> `event_registered` («Ви зареєстровані на подію»: назва, час
за Києвом, місце, кількість осіб; для старих payload без назви - загальний текст) і планування
нагадування за 24 год. `event.published` -> маркетингова розсилка `event_published` («Нова подія в Порт
City», та сама механіка, що й для акцій нижче; вид маркетинговий, потрібна згода `marketing`).

**Звернення в підтримку.** `support.request_created` (admin) -> учаснику в застосунок
`support_request_received` («Звернення № 1042 прийнято. Відповімо до 24 годин…», канал `inapp`,
службовий вид, вимкнути не можна) і лист на `SUPPORT_EMAIL` через `MailPort`: тема
«Звернення № N: <тема>», у тексті - час, ID, контакти учасника (`IDENTITY_PORT.getUser`: ім'я, телефон,
e-mail, код учасника), пов'язаний об'єкт, наявність фото, текст і шлях у бек-офісі; `replyTo` -
e-mail учасника. Лист іде після повідомлення: якщо провайдер упав, задача падає й повторюється
(повідомлення дедуплікується, лист - повторюється, тобто «щонайменше раз»). Без `SUPPORT_EMAIL`
лист пропускається з причиною в `ignored`. `SUPPORT_EMAIL` може містити кілька адрес через кому.

**Спір щодо паркування.** `parking.session.disputed` (раніше «лише аудит») -> `parking_disputed`
у застосунок («Звернення щодо паркування прийнято», текст за причиною `not_my_car | wrong_amount |
barrier`, ID сесії): після спору сесія зникає з героя, тож учасник отримує слід у скриньці.

**Маркетингові розсилки.** `promo.published` -> вид `promo_published` для учасників, яких повертає
`IDENTITY_PORT.listMarketingAudience(cursor, limit)` (активні учасники з чинною згодою `marketing`), сторінками
по 500 (`MARKETING_AUDIENCE_PAGE_SIZE`). Ключ дедуплікації один для всіх - `outbox:<eventId>` (унікальність
за парою учасник-ключ), тож повтор задачі нікому не надсилає вдруге. `notify()` ще раз перевіряє згоду й
налаштування кожного адресата.

**Паркінг (канон дизайн-брифу 4.1, час київський).**

| Подія                          | Вид                    | Заголовок                                                                                                                                |
| ------------------------------ | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `parking.session.opened`       | `parking_opened`       | «Ви на паркінгу Порт City. Безкоштовно до 14:30» (в'їзд + `freeMinutes` тарифу)                                                          |
| `parking.session.free_ending`  | `parking_free_ending`  | «Безкоштовні 30 хв закінчуються о 14:30»                                                                                                 |
| `parking.session.exit_soon`    | `parking_exit_soon`    | «Виїзд до 16:00 — залишилось 10 хв»                                                                                                      |
| `parking.session.still_inside` | `parking_still_inside` | «Ви ще на паркінгу?» (+ сума до сплати)                                                                                                  |
| `parking.session.closed`       | `parking_closed`       | окремі тексти для `closedReason = user_left` (спірна сесія: звернення в підтримку з ID сесії) і `timeout` (оператор не підтвердив виїзд) |

Сесії без учасника (неверифіковані номери) ігноруються.

**Акаунт.** `user.deletion_requested` -> `account_deletion_scheduled`; `user.deletion_cancelled` ->
`account_deletion_cancelled` («Видалення акаунта скасовано», службовий вид, вимкнути не можна).

**`user.deleted`.** Вхідні учасника (з рядками `PushDelivery` через `ON DELETE CASCADE`) і його
налаштування видаляються (`NotificationsService.eraseUserData`, ідемпотентно). Нагадування, заплановані
раніше, нічого не відновлюють: `notify()` пропускає неактивних учасників (`user_inactive`), а квитки й
ваучери видаленого акаунта скасовує rewards (подія `voucher.cancelled` знімає нагадування).

## Пошта (`services/mail/`)

`MailPort` (абстрактний клас-токен, як `PushPort`): `LogMailAdapter` (типово; пише в пам'ять і лог лише
адресатів і тему, без тексту з персональними даними) і `SmtpMailAdapter` - задокументований TODO
(план: `node:tls`/`node:net` + STARTTLS, AUTH LOGIN, UTF-8 text/plain), який відмовляється
створюватися: `MAIL_PROVIDER=smtp` валить старт із `MailProviderNotImplementedError` замість тихої
втрати листів. Секція середовища `mail` (`services/mail/mail.config.ts`) валідується окремо.

## Змінні середовища (секція `notifications`, `services/notifications.config.ts`)

| Змінна                                 | Типово                       | Опис                                             |
| -------------------------------------- | ---------------------------- | ------------------------------------------------ |
| `PUSH_PROVIDER`                        | `stub`                       | `stub` (пише в лог і пам'ять) або `fcm`          |
| `FCM_PROJECT_ID`                       | -                            | проєкт Firebase                                  |
| `FCM_SERVICE_ACCOUNT_JSON`             | -                            | JSON сервісного акаунта (сирий або base64)       |
| `FCM_ACCESS_TOKEN`                     | -                            | статичний токен для локальних експериментів      |
| `FCM_ENDPOINT`                         | `https://fcm.googleapis.com` | база API FCM                                     |
| `FCM_TIMEOUT_MS`                       | `10000`                      | таймаут HTTP                                     |
| `PUSH_MAX_ATTEMPTS`                    | `3`                          | спроб на пару повідомлення-пристрій              |
| `NOTIFICATIONS_TICKET_REMINDER_HOURS`  | `24`                         | за скільки годин до події нагадувати             |
| `NOTIFICATIONS_VOUCHER_EXPIRING_HOURS` | `24`                         | за скільки годин до кінця дії ваучера нагадувати |

Без облікових даних FCM адаптер повертає `not_configured` (доставки `skipped`) замість нескінченних повторів.

Секція `mail` (`services/mail/mail.config.ts`) і спільна змінна:

| Змінна          | Типово                                | Опис                                                                  |
| --------------- | ------------------------------------- | --------------------------------------------------------------------- |
| `MAIL_PROVIDER` | `log`                                 | `log` (лог і пам'ять) або `smtp` (TODO, відмовляє на старті)          |
| `MAIL_FROM`     | `Порт City <no-reply@portcity.local>` | відправник листів                                                     |
| `SUPPORT_EMAIL` | -                                     | спільна (`GET /mall/info`); адресати листів про звернення, через кому |

`MAIL_PROVIDER` і `MAIL_FROM` ще не внесені в `.env.example` (файл поза зоною модуля): integration-агенту
додати їх і секцію `mailEnvSchema` у `src/common/config/env-example.spec.ts`.

## Тести

`npx jest src/modules/notifications`: домен (види, шаблони, політика доставки, машина доставки,
push-повідомлення, нагадування, мапінг подій outbox, лист підтримці), поштові адаптери, задачі (`handleNotificationsEventJob`,
`processPushJob`), сервіси (`NotificationsService`, `PushDeliveryService` зі `StubPushAdapter`,
налаштування, планувальник нагадувань) на in-memory Prisma (`test/notifications/support/fake-notifications-prisma.ts`),
адаптери FCM (фейковий `fetch`, справжній RS256-підпис).

## Відкриті питання

1. Тексти повідомлень (`domain/templates.ts`) узгодити з копірайтом застосунку; тихі години для push
   не реалізовано - питання до замовника.
2. Офіційні SDK Google не потрібні (`docs/deps-requests/notifications.md`).
3. Масова розсилка йде однією задачею по всій аудиторії; для десятків тисяч адресатів варто розбити її на
   задачі по сторінці (зараз безпечно завдяки дедуплікації, але задача довга).
4. SMTP-адаптер не реалізовано (TODO у `smtp-mail.adapter.ts`); вибір провайдера (власний SMTP чи
   HTTP API сервісу розсилок) - за замовником. До того листи підтримці видно лише в лозі (`MAIL_PROVIDER=log`).
5. Сповіщення учаснику про зміну статусу звернення (вирішено/закрито) не надсилається - чи потрібне,
   вирішує замовник (подію для цього публікувати admin).

Закрито під час інтеграції (2026-11-01): аудиторія маркетингу (`IDENTITY_PORT.listMarketingAudience`),
колонка `dedupe_key`, нагадування паркінгу, `user.deletion_cancelled`, очищення за `user.deleted`.
