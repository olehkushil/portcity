# Модуль content

Довідник орендарів ТРЦ «Порт City», білий список фіскальних номерів кас, персональні правила
лояльності орендарів, інформація про ТРЦ (`GET /mall/info`) і заглушка імпорту з WordPress.
Надає порт `CONTENT_PORT` (`ContentPortService`) для receipts, rewards, promos та admin.
Залежить від club (`CLUB_LEDGER_PORT`: базова ставка для карток орендарів) і спільного шару.

English summary: tenants directory (weekly hours with exceptions, `isOpenNow` in Kyiv time with
the mall hours as fallback, `locationText`, `mapImageUrl`, public `GET /tenants/by-id/:id`),
fiscal number whitelist (canonical fn shared with receipts), per-tenant loyalty rules, mall info
(singleton `mall_info` edited through audited `PUT /admin/content/mall-info`, falling back to
configuration) and a WordPress import stub (synchronous or queued on `content-import`); provides
`CONTENT_PORT` (now with `getTenantSummaryById`); imports ClubModule for the base rate; admin CRUD
under `/admin/*` is audited.

## Модель (prisma/schema/content.prisma)

| Модель               | Призначення                                                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Tenant`             | орендар: `slug` (унікальний), назва, категорія (реєстр `TENANT_CATEGORIES`), поверх, лого, сайт, телефон, опис, `participates`, `ratePercentOverride`, `excludedFromProgram`, статус, `hours` (тижневий розклад, jsonb), `locationText`, `mapImageUrl` |
| `TenantFiscalNumber` | фіскальний номер каси (`fn` з QR податкової, канонічний: лише цифри без провідних нулів), прив'язка до орендаря, статус `active / pending / blocked`, джерело `admin / receipt / import`, хто і коли підтвердив |
| `TenantLoyaltyRule`  | тимчасове правило орендаря: `ratePercent`, `minTotalKopecks`, `dailyCapPoints`, період `[validFrom, validTo)`                                                                        |
| `ContentImportRun`   | журнал запусків імпорту: джерело, статус `running / succeeded / failed`, статистика (jsonb), помилка                                                                                 |
| `MallInfo`           | одиничний рядок (`id = 1`, CHECK) з розширеною інформацією про ТРЦ, яку редагує бек-офіс; порожні поля беруться з конфігурації                                                       |

Зміни схеми й заповнення даних — міграція `prisma/schema/migrations/20261101180000_review_fixes`
(канонізація `fn` білого списку зі звітом `fiscal_number_canonical_collisions`, розділ 4a); seed
(години, розташування орендарів, рядок `mall_info`) — `prisma/seed.ts`. Архів початкових файлів —
`docs/pending-sql/applied/receipts-content.*`.

### Години роботи орендаря (domain/tenant-hours.ts)

`Tenant.hours` (час Києва):

```json
{
  "mon": ["10:00-22:00"], "tue": ["10:00-14:00", "15:00-22:00"], "fri": ["18:00-02:00"], "sun": [],
  "exceptions": [
    { "date": "2026-12-31", "ranges": ["10:00-18:00"], "note": "Передноворічний день" },
    { "date": "2027-01-01", "closed": true }
  ]
}
```

День без ключа (або `hours = null`) — діють години ТРЦ (`mall_info.hours`, потім `MALL_HOURS`,
потім 10:00-22:00); `[]` — вихідний; виняток замінює розклад своєї дати; діапазон, що закінчується
раніше, ніж почався, триває після півночі (хвіст рахується до наступного дня). До 4 діапазонів на
день, до 60 винятків. Адмін-API нормалізує розклад і відхиляє помилки (`PC_COMMON_VALIDATION`,
`details.field = hours`); збережений некоректний JSON читається як `null`. `isOpenNow` рахується
на момент запиту.

### Канонічний номер каси

`parseFiscalNumber` / `normalizeFiscalNumber` використовують `canonicalFiscalNumber`
(`src/common/contracts/content.ts`) — ту саму функцію, що й receipts: роздільники (пробіли, дефіси)
прибираються, лише цифри, провідні нулі відкидаються, далі 6-20 цифр. Тому `04000100011`,
`4000-100-011` і `4000100011` — одна каса, а пошук у білому списку завжди збігається з ключем чека.
Пошук адміна за префіксом теж ігнорує провідні нулі.

Періоди правил одного орендаря не перетинаються: застосунок перевіряє це під `SELECT ... FOR UPDATE`
орендаря, а БД додатково тримає exclusion constraint `tenant_loyalty_rules_no_overlap` (btree_gist,
міграція `20261101120000_module_requests`); його порушення (SQLSTATE 23P01) сервіс перетворює на
`PC_TENANT_RULE_OVERLAP` (409).

## Стани (domain/, чисті функції з табличними тестами)

```
Tenant:        active <-> hidden ; active | hidden -> closed ; closed -> active
FiscalNumber:  pending -> active | blocked ; active -> blocked ; blocked -> active | pending
               (active завжди прив'язаний до орендаря; active -> pending заборонено - лише блокування)
```

- Публічно видно лише `active` орендарів; `hidden` і `closed` на `GET /tenants/:slug` дають 404.
- `isExcluded` порту повертає `true`, якщо орендаря немає, він `excludedFromProgram`, не `participates`
  або `closed` (прихований орендар бали нараховує).
- Ефективне правило (`getTenantRule`): активне `TenantLoyaltyRule` > `ratePercentOverride` > немає
  (`ratePercent = null` - діє `baseRatePercent` активного набору правил club).
- Перетин періодів правил одного орендаря заборонено (`PC_TENANT_RULE_OVERLAP`); записи серіалізуються
  через `SELECT ... FROM tenants ... FOR UPDATE`.

### "Нараховує бали" та ефективна ставка (domain/tenant-earning.ts)

`describeTenantEarning(tenant, effectiveRule, baseRatePercent)`:

- орендар виключений / не бере участі / закритий -> `earnsPoints = false`, `effectiveRatePercent = 0`,
  `rateSource = none`;
- інакше ставка = правило, override або базова ставка (`rateSource = rule | override | base`);
  ставка 0 означає `earnsPoints = false`.

Базову ставку читає `BaseRateService` з `CLUB_LEDGER_PORT.getActiveRules()`: `ContentModule`
імпортує `ClubModule` (club залежить лише від identity, циклу немає), кеш 60 с; якщо леджер
недоступний (помилка БД) - 3 % (`DEFAULT_LOYALTY_RULES`).

## Ендпоїнти (префікс `/api/v1`)

Публічні (без токена):

| Метод і шлях              | Опис                                                                                                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /tenants`            | активні орендарі, курсорна пагінація `?cursor=&limit=`, фільтри `participates`, `category`, `floor`, `q` (назва або slug); кожен елемент має `earnsPoints`, `effectiveRatePercent`, `rateSource`, `hours`, `isOpenNow`, `locationText`, `mapImageUrl` |
| `GET /tenants/categories` | категорії активних орендарів з кількістю (чипи фільтра)                                                                                                                                          |
| `GET /tenants/:slug`      | картка орендаря: усе з елемента списку плюс `minTotalKopecks`, `dailyCapPoints` активного правила                                                                                                |
| `GET /tenants/by-id/:id`  | та сама картка за id (посилання з ваучерів, акцій, чеків); приховані й закриті — 404                                                                                                             |
| `GET /mall/info`          | назва, адреса, сайт, години й `isOpenNow` (час Києва), паркінг (підземний 08:00-21:00, наземний 05:00-24:00), підтримка, `telegramUrl`, `infoDesk {location, hours}`, `parkingOperator {name, phone, hours}`, `rulesPdfUrl`, `legalDocuments [{key, title, url}]`, `floorMapUrls [{floor, url}]`, `parkingMapUrl`. Дані з `mall_info` (кеш 30 с), порожні поля — з конфігурації (`MALL_ADDRESS`, `MALL_HOURS`, `SUPPORT_PHONE`, `SUPPORT_EMAIL`); якщо БД недоступна, відповідає конфігурація |

Бек-офіс (`@Auth('admin', ...)`, `owner` проходить усі перевірки; усі зміни пишуться в аудит через
`ADMIN_AUDIT_PORT`):

| Метод і шлях                                | Ролі (крім owner)           | Опис                                                                       |
| ------------------------------------------- | --------------------------- | -------------------------------------------------------------------------- |
| `GET /admin/tenants`                        | manager, moderator, support | усі статуси, фільтри як у публічному списку плюс `status`                  |
| `POST /admin/tenants`                       | manager                     | створення (slug з назви, якщо не задано; транслітерація української)       |
| `GET /admin/tenants/:id`                    | manager, moderator, support | деталі з кількістю фіскальних номерів і правил                             |
| `GET /admin/tenants/:id/effective-rule?at=` | manager, moderator, support | правило, що діє в момент `at` (типово зараз)                               |
| `PATCH /admin/tenants/:id`                  | manager                     | часткове оновлення, лише змінені поля; статус за автоматом станів          |
| `DELETE /admin/tenants/:id`                 | manager                     | м'яке видалення: статус `closed` (історія чеків/ваучерів зберігає зв'язок) |
| `GET /admin/fiscal-numbers`                 | manager, moderator, support | фільтри `status`, `source`, `tenantId`, `unmapped`, `q` (префікс номера)   |
| `POST /admin/fiscal-numbers`                | manager, moderator          | реєстрація номера (з `tenantId` - одразу `active`)                         |
| `GET /admin/fiscal-numbers/:id`             | manager, moderator, support | деталі                                                                     |
| `PATCH /admin/fiscal-numbers/:id`           | manager, moderator          | прив'язка, нотатка, статус                                                 |
| `POST /admin/fiscal-numbers/:id/confirm`    | manager, moderator          | підтвердити номер, знайдений у чеках (`pending` -> `active`, з `tenantId`) |
| `POST /admin/fiscal-numbers/:id/block`      | manager, moderator          | заблокувати номер                                                          |
| `DELETE /admin/fiscal-numbers/:id`          | manager, moderator          | видалити `pending` або `blocked` (активний - лише блокувати)               |
| `GET /admin/tenant-rules`                   | manager, moderator, support | фільтри `tenantId`, `activeAt`, курсор                                     |
| `POST /admin/tenant-rules`                  | manager                     | нове правило (`tenantId` у тілі)                                           |
| `GET /admin/tenant-rules/:id`               | manager, moderator, support | деталі                                                                     |
| `PATCH /admin/tenant-rules/:id`             | manager                     | ставка, мінімум, ліміт, період                                             |
| `DELETE /admin/tenant-rules/:id`            | manager                     | видалення                                                                  |
| `POST /admin/content/import`                | manager                     | заглушка імпорту WordPress (`posts` з wp/v2 або `items`, `dryRun`); 201 - синхронний запуск, з `async: true` - 202 і запуск у статусі `running` (черга `content-import`) |
| `GET /admin/content/import-runs`            | manager, moderator, support | журнал запусків, фільтр `status`                                           |
| `GET /admin/content/import-runs/:id`        | manager, moderator, support | запуск зі статистикою                                                      |
| `GET /admin/content/mall-info`              | manager, moderator, support | збережені поля `mall_info` (`null` = конфігурація), хто й коли змінив, `effective` — поточна відповідь `GET /mall/info` |
| `PUT /admin/content/mall-info`              | manager                     | повна заміна (PUT): `address`, `hours` (`HH:mm-HH:mm`), `telegramUrl`, `infoDesk`, `parkingOperator`, `rulesPdfUrl`, `legalDocuments` (до 20), `floorMapUrls` (до 20), `parkingMapUrl`, `support`; пропущене поле повертається до конфігурації |

Створення й оновлення орендаря (`POST`/`PATCH /admin/tenants`) приймають також `hours` (об'єкт
розкладу або `null`), `locationText` (до 200 символів), `mapImageUrl` (http/https URL).

Дії аудиту: `tenant.create|update|close`, `fiscal_number.create|update|confirm|block|delete`,
`tenant_rule.create|update|delete`, `content_import.run`, `mall_info.update`.

## Порт CONTENT_PORT

`getTenant`, `getTenantSummaryById` (`TenantDisplaySummary`: усе з `TenantSummary` плюс `logoUrl`,
`locationText`, `mapImageUrl`, `isOpenNow`; будь-який статус — перевіряйте `status` перед показом),
`getTenants`, `findTenantByFiscalNumber` (null для невідомих і некоректних номерів; вхід
канонізується), `isExcluded`, `getTenantRule`, `recordSeenFiscalNumber(fn, tx?, { receiptId }?)`
(вставка `pending / receipt` через `INSERT ... ON CONFLICT DO NOTHING` у транзакції викликача; подія
лише для нового рядка). `ContentModule` експортує `CONTENT_PORT`, `ContentPortService`,
`TenantsService`, `FiscalNumbersService`.

## Сховище зображень

Лого, карти й зображення ТРЦ лежать під публічними префіксами `StoragePort`
(`tenants/`, `promos/`, `events/`, `rewards/`, `banners/`, `mall/`): `StoragePort.publicUrl(key)`
повертає постійний URL (`S3_PUBLIC_BASE_URL`) лише для них. Усе інше (зокрема
`receipts/<userId>/...`) — приватне: лише підписані посилання до 1 год
(`createPresignedDownload`), навіть якщо `S3_PUBLIC_BASE_URL` задано. Лого орендарів будуються з
`MALL_LOGO_BASE_URL` або `S3_PUBLIC_BASE_URL` + `logoKey`.

## Події outbox

| Подія                            | Коли                                                                      |
| -------------------------------- | ------------------------------------------------------------------------- |
| `tenant.updated`                 | зміна полів орендаря (`changedFields`) або його правил (`loyaltyRules`)   |
| `tenant.fiscal_number_seen`      | новий фіскальний номер із чека (`pending`)                                |
| `tenant.fiscal_number_confirmed` | зміна статусу номера або перепризначення активного номера іншому орендарю |

Модуль не споживає подій. Власна черга: `content-import` (асинхронні запуски імпорту).

## Задачі (jobs/)

`runContentImport` (`jobs/content-import.job.ts`) - чиста функція з юніт-тестом: нормалізує записи
(slug, категорія з українських/англійських назв, поверх, HTML -> текст), відкидає дублікати, створює
нових орендарів (`participates = false`, статус з `defaults`) і оновлює лише змінені поля існуючих
(за slug). `ContentImportService` виконує її в одній транзакції та пише результат у
`content_import_runs`:

- типово синхронно в межах запиту (201 з завершеним запуском);
- з `async: true` - створює запуск `running`, ставить задачу `run` у чергу `content-import`
  (`jobId = content-import-<runId>`, 3 спроби) і відповідає 202; воркер (`ContentImportProcessor` ->
  чиста функція `handleContentImportQueueJob`, `jobs/content-import-queue.job.ts`) виконує імпорт і
  завершує запуск (`succeeded` або `failed` з помилкою). Запуск, що вже не `running`, пропускається
  (повтор задачі ідемпотентний); помилка імпорту записується в запуск і не повторюється. Стан -
  `GET /admin/content/import-runs/:id`.

Розкладу немає (з'явиться разом зі справжнім клієнтом WordPress REST API).

## Змінні середовища

Спільні (`APP_CONFIG`): `MALL_NAME`, `MALL_ADDRESS` (типово `просп. Соборності, 43, Луцьк`,
`DEFAULT_MALL_ADDRESS` у `src/common/config`), `MALL_HOURS` (`10:00-22:00`), `SUPPORT_PHONE`,
`SUPPORT_EMAIL`, `S3_PUBLIC_BASE_URL`.

Власні (секція `content`, `services/content.config.ts`):

| Змінна                           | Типово                    | Опис                                              |
| -------------------------------- | ------------------------- | ------------------------------------------------- |
| `MALL_WEBSITE`                   | `https://portcity.com.ua` | сайт ТРЦ у `GET /mall/info`                       |
| `MALL_PARKING_UNDERGROUND_HOURS` | `08:00-21:00`             | години підземного паркінгу (довідково)            |
| `MALL_PARKING_SURFACE_HOURS`     | `05:00-24:00`             | години наземного паркінгу (довідково)             |
| `MALL_LOGO_BASE_URL`             | `S3_PUBLIC_BASE_URL`      | база URL логотипів (`logoUrl = <база>/<logoKey>`) |

## Тести

- `npx jest src/modules/content` - юніт-тести домену (автомати станів, slug, канонічні фіскальні
  номери, правила, години ТРЦ і тижневі години орендарів з винятками й нічними діапазонами,
  `mall_info`, імпорт, ставка) і сервісів з фейками Prisma/аудиту/outbox (зокрема `MallInfoService`
  з кешем і відкатом до конфігурації, `getTenantSummaryById`, `GET /tenants/by-id`).
- `npx jest --config test/jest-e2e.config.js test/content` - маршрути, валідація, гварди й ролі
  контролерів на повному `AppModule` (сервіси з БД і `MallInfoRepository` замінені фейками),
  включно з `PUT /admin/content/mall-info` і `GET /tenants/by-id/:id`.
- `test/content/content.int-spec.ts` - сервіси проти PostgreSQL (самопропуск без `DATABASE_URL`, у CI).

## Відкриті питання

1. Реальний клієнт WordPress REST API і нічний імпорт за розкладом (зараз адмін передає пости в
   тілі запиту; асинхронний режим через чергу `content-import` уже є).
2. Чи треба при закритті орендаря автоматично блокувати його фіскальні номери (зараз чеки закритого
   орендаря просто не нараховують бали через `isExcluded`).
3. `mapImageUrl` — довільний http/https URL; коли бек-офіс почне завантажувати карти в сховище,
   додати `mapImageKey` під префіксом `mall/` і будувати URL через `StoragePort.publicUrl()`.
4. Кеш `mall_info` (30 с) живе в процесі: після `PUT` інші репліки API бачать зміни до 30 с пізніше.

Закрито 2026-11-01 (рев'ю): години роботи орендарів з `isOpenNow`, `locationText`, `mapImageUrl`,
`GET /tenants/by-id/:id`, таблиця `mall_info` з `PUT /admin/content/mall-info` (аудит),
канонічні номери кас, `getTenantSummaryById` у порту.

Закрито під час інтеграції (2026-11-01): коди помилок у контракті (content-1), `receiptId` у
`recordSeenFiscalNumber` (content-2), черга `content-import` з асинхронним режимом (content-3),
типове `MALL_ADDRESS` у спільній схемі та прибраний обхідний шлях (content-4), імпорт `ClubModule`
для базової ставки (content-5), exclusion constraint правил (schema content-1).
