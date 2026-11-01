# Модуль promos

Акції (інформаційні та з купоном), шаблони купонів, події (афіша) і реєстрації на них з квитками.
Купони й квитки - це ваучери модуля rewards: promos видає їх лише через `VOUCHER_ISSUER_PORT`
(контракт `src/common/contracts/rewards.ts`) і не пише в таблиці rewards. Надає `PROMOS_PORT`
(`PromosPortService`: `getPromo`, `getEvent`, `validateClaim`) для admin і notifications.

English summary: promos, coupon templates, events and registrations; coupons and tickets are
vouchers issued through VOUCHER_ISSUER_PORT. Provides PROMOS_PORT; depends on rewards and content.

## Модель (`prisma/schema/promos.prisma`)

| Модель              | Ключові поля                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Promo`             | `tenantId?`, `title`, `body`, `kind` (`info`/`coupon`), `category` (`fashion`/`food`/`entertainment`/`kids`/`beauty`/`electronics`/`other`), `validFrom`, `validTo`, `imageKey?`, `status`, `couponTemplateId?` (унікальний), `priority`                                                                                                                                                                                                   |
| `CouponTemplate`    | `discountText`, `perUserLimit` (типово 1), `totalLimit?` (null - без ліміту), `claimedCount`, `requiresActivation`, `validityHoursAfterClaim?`, `terms`                                                                                                                                                                                                                                                                                    |
| `Event`             | `title`, `startsAt`, `endsAt`, `venue`, `category` (`kids`/`masterclass`/`cinema`/`concert`/`other`), `tenantId?` (орендар-організатор, FK у SQL без Prisma-зв'язку), `capacity?` (особи), `registeredCount` (особи активних реєстрацій), `registrationOpen`, `admission` (`registration`/`external`), `externalUrl?`, `maxPersonsPerRegistration?`, `ageMin?`, `ageMax?`, `ageLimit?` (застаріле, мінімальний вік), `imageKey?`, `status` |
| `EventRegistration` | `eventId`, `userId` (унікальна пара), `adults` (>= 1), `children`, `voucherId` (квиток), `status`, `cancelledAt`                                                                                                                                                                                                                                                                                                                           |
| `CouponClaim`       | `promoId`, `couponTemplateId`, `userId`, `voucherId` (купон, унікальний), `status` (`active`/`cancelled`), `cancelledAt`                                                                                                                                                                                                                                                                                                                   |

Купон. Кожна заявка - рядок `CouponClaim` (`coupon_claims`: `promoId`, `couponTemplateId`, `userId`,
`voucherId`, статус `active | cancelled`, `cancelledAt`). Під `SELECT ... FOR UPDATE` рядка шаблону
сервіс рахує активні заявки учасника на акцію (ліміт `perUserLimit`; скасовані не рахуються) і загальний
пул за `claimedCount` (`totalLimit`), видає ваучер через `VOUCHER_ISSUER_PORT` з `sourceType: 'promo'`,
`sourceId = id заявки`, записує заявку з `voucherId` і збільшує `claimedCount` - усе в одній транзакції.
`expiresAt` купона = `claim + validityHoursAfterClaim`, але не пізніше `validTo` акції; `meta` містить
`promoId`, `couponTemplateId`, `claimId`, `discountText`, `terms`, `requiresActivation`. Стан заявки на
`GET /promos/:id` (`claimedByMe`, `allowed`) рахується з таблиці одним запитом. Наявні купони до міграції
`20261101120000_module_requests` перенесено в таблицю (id заявки = `sourceId` ваучера).

Квиток. Реєстрація створює рядок і в тій самій транзакції (під блокуванням рядка події) видає ваучер
`kind: 'ticket'`, `sourceType: 'event'`, `sourceId: registrationId`, `expiresAt = endsAt`, `meta` з
кількістю осіб. Скасування закриває реєстрацію, повертає місця і скасовує квиток через
`VOUCHER_ISSUER_PORT.cancel` (`refundPoints: false`); уже фінальний квиток лишається як є.

## Машини станів

```
Promo:         draft -> published -> archived ; draft -> archived
Event:         draft -> published -> finished | cancelled ; draft -> cancelled
Registration:  active -> used | cancelled
Ticket (BRIEF розділ 6, похідний статус для застосунку): active -> used | cancelled | expired
```

Статус квитка обчислює `deriveTicketStatus` з реєстрації, статусу ваучера і часу (після `endsAt`
живий квиток - `expired`). Усі машини - чисті функції в `domain/` з табличними тестами.

Правила реєстрації (`domain/event-rules.ts`): подія `published`, `admission = registration`,
`registrationOpen`, ще не почалась, прапорець `events.registration` увімкнено (за відсутності рядка -
увімкнено), щонайменше 1 дорослий, не більше `maxPersonsPerRegistration` осіб, вистачає місць. Ліміт
осіб (`effectiveMaxPersons`): значення події, інакше `maxPersonsPerRegistration` з payload прапорця
`events.registration` (seed: 4, рішення 01.11.2026), інакше 4; жорстко закодованих 4 більше немає (DTO лише обмежує 1-20).
Подія з `admission = external` реєстрацій не приймає (`PC_EVENT_REGISTRATION_CLOSED`), клієнт веде на
`externalUrl`. Учасник може скасувати до 11:00 за Києвом у день події (або до початку, якщо подія
раніше); адміністратор - будь-коли. Дедлайн обчислюється й на самій події (`EventDto.cancelDeadline`,
`null` для зовнішнього входу).

Відповіді (`services/promos-presenter.service.ts`, `PromosPresenter`): картка орендаря (`tenant`, одним
запитом до `CONTENT_PORT` на сторінку) для акцій і подій, `imageUrl` = `S3_PUBLIC_BASE_URL` + `imageKey`
(`null`, якщо ключа чи бази немає; абсолютний http(s)-ключ повертається як є), ефективний
`maxPersonsPerRegistration` події.

Гостьовий доступ (рішення продукту): `GET /promos`, `GET /promos/:id`, `GET /events`, `GET /events/:id`
мають `@OptionalAuth()`. Без токена: `claim = { allowed: false, code: 'PC_AUTH_REQUIRED' }`
(`GUEST_CLAIM_CODE`, не помилка API) і `registration = null`. Токен учасника працює як раніше,
прострочений або зіпсований токен - 401, токен адміністратора - 403. Заявка на купон і реєстрація
лишаються лише для учасників.

## Ендпоїнти (префікс `/api/v1`)

Учасник (`@Auth('member')`; чотири GET - `@OptionalAuth()`, доступні гостям):

| Метод і шлях                  | Опис                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `GET /promos`                 | гість або учасник: опубліковані акції у вікні дії, `?tenantId=&kind=&category=&cursor=&limit=`, за пріоритетом           |
| `GET /promos/:id`             | гість або учасник: деталі зі станом заявки (`claim.allowed`, `claimedByMe`; гість - `PC_AUTH_REQUIRED`)                  |
| `POST /promos/:id/claim`      | видати купон (`Idempotency-Key`, 10 запитів/хв) -> ваучер `coupon`                                                       |
| `GET /events`                 | гість або учасник: афіша `?scope=upcoming` (типово) або `past`, `?category=`                                             |
| `GET /events/:id`             | гість або учасник: деталі (учаснику - з реєстрацією і квитком)                                                           |
| `POST /events/:id/register`   | `{ adults, children }` (`Idempotency-Key`, 10 запитів/хв) -> реєстрація з квитком; не більше `maxPersonsPerRegistration` |
| `DELETE /events/:id/register` | скасувати реєстрацію (до дедлайну)                                                                                       |

Бек-офіс (`@Auth('admin', 'manager', 'support', 'moderator')` на читання, запис - `manager`; `owner` завжди):

| Метод і шлях                                                                                              | Опис                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /admin/promos`, `GET /admin/promos/:id`                                                              | список (будь-який статус, `?status=&tenantId=&kind=&category=&q=`) і деталі                                                                                                                                                                                                                                                                                |
| `POST /admin/promos`                                                                                      | чернетка (можна з вбудованим `couponTemplate`), `category`                                                                                                                                                                                                                                                                                                 |
| `PATCH /admin/promos/:id`                                                                                 | зміна полів                                                                                                                                                                                                                                                                                                                                                |
| `DELETE /admin/promos/:id`                                                                                | видалити чернетку                                                                                                                                                                                                                                                                                                                                          |
| `POST /admin/promos/:id/publish`                                                                          | опублікувати (подія `promo.published`)                                                                                                                                                                                                                                                                                                                     |
| `POST /admin/promos/:id/archive`                                                                          | архівувати                                                                                                                                                                                                                                                                                                                                                 |
| `GET /admin/coupon-templates`, `GET /admin/coupon-templates/:id`                                          | список і деталі                                                                                                                                                                                                                                                                                                                                            |
| `POST /admin/coupon-templates`, `PATCH /admin/coupon-templates/:id`, `DELETE /admin/coupon-templates/:id` | CRUD (видалення - лише не прив'язаного)                                                                                                                                                                                                                                                                                                                    |
| `GET /admin/events`, `GET /admin/events/:id`                                                              | список (`?status=&category=&q=`) і деталі                                                                                                                                                                                                                                                                                                                  |
| `POST /admin/events`, `PATCH /admin/events/:id`, `DELETE /admin/events/:id`                               | CRUD (місткість не нижче зареєстрованих, видалення - лише чернетки); `category`, `tenantId` (перевірка через `CONTENT_PORT`, `PC_EVENT_TENANT_NOT_FOUND`), `admission` + `externalUrl` (`PC_EVENT_ADMISSION_INVALID`; на `external` не можна перейти з реєстраціями), `maxPersonsPerRegistration` (1-20), `ageMin`/`ageMax` (`PC_EVENT_AGE_RANGE_INVALID`) |
| `POST /admin/events/:id/publish`                                                                          | опублікувати (подія `event.published`)                                                                                                                                                                                                                                                                                                                     |
| `POST /admin/events/:id/cancel`                                                                           | скасувати з каскадом: усі активні реєстрації і квитки, подія `event.cancelled`                                                                                                                                                                                                                                                                             |
| `POST /admin/events/:id/finish`                                                                           | завершити вручну                                                                                                                                                                                                                                                                                                                                           |
| `GET /admin/events/:id/registrations`                                                                     | реєстрації події, `?status=`                                                                                                                                                                                                                                                                                                                               |
| `POST /admin/events/:id/registrations/:registrationId/cancel`                                             | скасувати одну реєстрацію                                                                                                                                                                                                                                                                                                                                  |

Кожна мутація бек-офісу аудитується через `ADMIN_AUDIT_PORT` у тій самій транзакції, що й зміна.

## Події outbox

Публікує: `promo.published`, `promo.coupon_claimed`, `event.registered` (тепер з `title` і `venue`
для підтвердження), `event.registration_cancelled`, `event.cancelled`, `event.published` (анонс
події: `eventId`, `title`, `category`, `tenantId`, `venue`, `startsAt`, `endsAt`, `admission`;
споживач усіх - notifications).
Споживає (черга `promos-events`): `voucher.redeemed` (квиток погашено -> реєстрація `used`),
`voucher.cancelled` (квиток скасовано в rewards -> реєстрація `cancelled`; купон -> заявка `sourceId`
стає `cancelled`, `claimedCount - 1`; лише перехід з `active` повертає купон у пул, повтор події нічого
не змінює).

## Задачі воркера

| Черга           | Задача                                  | Розклад  | Що робить                                          |
| --------------- | --------------------------------------- | -------- | -------------------------------------------------- |
| `promos-events` | `voucher.redeemed`, `voucher.cancelled` | outbox   | див. вище, ідемпотентно (повтор - `already_final`) |
| `promos-events` | `promos-finish-events`                  | щогодини | опубліковані події з `endsAt <= now` -> `finished` |

Логіка - чиста функція `handlePromosEventsJob` (`jobs/promos-events.handlers.ts`, юніт-тест).

## Змінні середовища

Власних немає. Спільна `S3_PUBLIC_BASE_URL` дає `imageUrl` акцій і подій (без неї - `null`).
Прапорець `events.registration` (`FEATURE_FLAG_KEYS.eventsRegistration`) вимикає реєстрацію без
релізу, його payload `{ maxPersonsPerRegistration }` задає типовий ліміт осіб.

## Схема й SQL (2026-11-01)

Нові enum `PromoCategory`, `EventCategory`, `EventAdmission` і колонки акцій/подій - у
`prisma/schema/promos.prisma`; міграція `prisma/schema/migrations/20261101180000_review_fixes` (FK
`events.tenant_id`, CHECK віку, ліміту осіб і `external_url`, часткові індекси афіші й списку акцій
за категорією - розділ 2.6). Дані seed - `prisma/seed.ts` (демо-подія masterclass Figli Migli 4-10
років до 4 осіб, подія з зовнішнім входом, категорії акцій). Архів -
`docs/pending-sql/applied/promos-notifications-admin.*`.

## Тести

`npx jest src/modules/promos`: домен (правила акцій і подій, ліміт осіб із прапорця, зовнішній вхід,
вік, `imageUrl`, машини станів, квитки, коди помилок), задача `promos-events`, сервіси `PromosService`
(видача купона через порт, ліміти, гість, категорія, `imageUrl`), `EventsService` (квиток через порт,
скасування, споживачі outbox, гість, категорія, ліміт осіб), адмін-сервіси (аудит у транзакції,
каскад скасування, нові поля подій, `event.published`) на фейках Prisma і контрактному фейку
`VOUCHER_ISSUER_PORT`. E2E: `test/promos/promos.e2e-spec.ts` (маршрути, ролі, optional auth у OpenAPI),
`test/promos/guest-access.e2e-spec.ts` (гість і учасник на сервісах-фейках),
`test/promos/idempotency.e2e-spec.ts` (регресія: той самий `Idempotency-Key` на іншій акції - 409).

## Відкриті питання

1. Перенесення часу опублікованої події не переписує вже видані квитки (`expiresAt`, `meta`); для
   справжнього переносу - скасувати і створити заново. Чи потрібен перевипуск квитків - питання до замовника.
2. Дедлайн скасування 11:00 у день події взято з прототипу; підтвердити із замовником. Ліміт осіб тепер
   налаштовується (подія, payload прапорця), але seed-прапорець має 6, а прототип каже 4 - узгодити.
3. Набір категорій акцій (`PromoCategory`) взято з чіпсів прототипу; категорії орендарів (`TENANT_CATEGORIES`)
   ширші - чи потрібна відповідність, вирішує замовник.

Закрито під час інтеграції (2026-11-01): таблиця `coupon_claims` замість детермінованих слотів
(повернення купона в пул більше не залежить від `meta` ваучера), коди помилок бек-офісу внесено в
`PROMOS_ERROR_CODES`.
