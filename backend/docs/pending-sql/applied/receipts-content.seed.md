> **Застосовано (архів).** Внесено в `prisma/seed.ts` 01.11.2026 (схема - міграцією
> `20261101180000_review_fixes`): `fnRaw`/`fiscalIdRaw` демо-чеків, години, розташування й карта
> всіх 14 орендарів (години перевіряються `parseTenantHours` під час seed), рядок `mall_info`.

# Зміни seed для receipts + content (2026-11-01)

Файл для агента, який веде `prisma/seed.ts` (receipts/content його не редагують). Спершу застосувати
`docs/pending-sql/receipts-content.sql` (нові колонки `tenants.hours|location_text|map_image_url`,
таблиця `mall_info`, колонки `receipts.fn_raw|fiscal_id_raw|verification|verify_until|verification_checked_at`).

## 1. Канонічні номери чеків — змін не потрібно

Усі `fn` (`4000100011` ... `4000100142`, `4009999999`) і `fiscalId` (`1180000001` ... `1180000003`) у
seed уже канонічні (лише цифри, без провідних нулів), тож `upsert` за `fn_fiscalId` лишається
коректним. Бажано (не обов'язково) заповнювати аудит-колонки сирими значеннями в `upsertReceipt`:

```ts
// у data чека
fnRaw: seed.fn,
fiscalIdRaw: seed.fiscalId,
// verification лишається типовим 'not_required' (демо-чеки створені до утримання на перевірку)
```

Ручний демо-чек (`rejected`, `fn_unknown`) може лишитися з `fn = '4009999999'`; новий CHECK
`receipts_fn_required_for_qr` дозволяє `fn = NULL` лише для `source = 'manual'`.

## 2. Години роботи, розташування і карта орендарів

Формат `Tenant.hours` (JSON, час Києва; день без ключа = години ТРЦ, `[]` = вихідний, `exceptions`
замінюють окремі дати): див. `src/modules/content/domain/tenant-hours.ts`. Додати до `TenantSeed`
поля `hours?`, `locationText`, `mapImageUrl` і передавати їх в `create`/`update` upsert-а орендаря
(`hours: seed.hours ?? Prisma.DbNull`).

| slug             | hours (JSON)                                                                                                                                                  | locationText                             | mapImageUrl (ключ `mall/...` у публічному сховищі) |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------- |
| `intertop`       | `null` (години ТРЦ) + `{"exceptions":[{"date":"2026-12-31","ranges":["10:00-18:00"],"note":"Передноворічний день"}]}`                                         | 1 поверх, ліворуч від центрального входу | `https://cdn.portcity.com.ua/mall/floor-1.png`     |
| `aroma-kava`     | `{"mon":["08:00-22:00"],"tue":["08:00-22:00"],"wed":["08:00-22:00"],"thu":["08:00-22:00"],"fri":["08:00-22:00"],"sat":["09:00-22:00"],"sun":["09:00-22:00"]}` | 1 поверх, біля центрального входу        | `https://cdn.portcity.com.ua/mall/floor-1.png`     |
| `coffee-gelato`  | `null`                                                                                                                                                        | 2 поверх, біля ескалатора                | `https://cdn.portcity.com.ua/mall/floor-2.png`     |
| `premier-city`   | `{"mon":["10:00-24:00"],"tue":["10:00-24:00"],"wed":["10:00-24:00"],"thu":["10:00-24:00"],"fri":["10:00-01:00"],"sat":["10:00-01:00"],"sun":["10:00-24:00"]}` | 3 поверх, кінотеатр                      | `https://cdn.portcity.com.ua/mall/floor-3.png`     |
| `strike-city`    | `{"mon":["12:00-24:00"],"tue":["12:00-24:00"],"wed":["12:00-24:00"],"thu":["12:00-24:00"],"fri":["12:00-02:00"],"sat":["11:00-02:00"],"sun":["11:00-24:00"]}` | 3 поверх, праворуч від кінотеатру        | `https://cdn.portcity.com.ua/mall/floor-3.png`     |
| `generator-city` | `{"mon":["11:00-22:00"],"tue":["11:00-22:00"],"wed":["11:00-22:00"],"thu":["11:00-22:00"],"fri":["11:00-23:00"],"sat":["10:00-23:00"],"sun":["10:00-22:00"]}` | 3 поверх, ігрова зона                    | `https://cdn.portcity.com.ua/mall/floor-3.png`     |
| `figli-migli`    | `{"mon":["10:00-21:00"],"tue":["10:00-21:00"],"wed":["10:00-21:00"],"thu":["10:00-21:00"],"fri":["10:00-21:00"],"sat":["10:00-21:00"],"sun":["10:00-21:00"]}` | 3 поверх, дитяча зона                    | `https://cdn.portcity.com.ua/mall/floor-3.png`     |
| `tamtam`         | `{"mon":["08:00-23:00"],"tue":["08:00-23:00"],"wed":["08:00-23:00"],"thu":["08:00-23:00"],"fri":["08:00-23:00"],"sat":["08:00-23:00"],"sun":["08:00-23:00"]}` | цокольний поверх, гіпермаркет            | `https://cdn.portcity.com.ua/mall/floor-0.png`     |
| `sport-point`    | `null`                                                                                                                                                        | 2 поверх, галерея                        | `https://cdn.portcity.com.ua/mall/floor-2.png`     |
| `techno-hub`     | `null`                                                                                                                                                        | 2 поверх, біля фуд-корту                 | `https://cdn.portcity.com.ua/mall/floor-2.png`     |
| `beauty-room`    | `{"mon":["10:00-21:00"],"tue":["10:00-21:00"],"wed":["10:00-21:00"],"thu":["10:00-21:00"],"fri":["10:00-21:00"],"sat":["10:00-20:00"],"sun":[]}`              | 1 поверх, праве крило                    | `https://cdn.portcity.com.ua/mall/floor-1.png`     |
| `apteka-24`      | `{"mon":["00:00-24:00"],"tue":["00:00-24:00"],"wed":["00:00-24:00"],"thu":["00:00-24:00"],"fri":["00:00-24:00"],"sat":["00:00-24:00"],"sun":["00:00-24:00"]}` | цокольний поверх, окремий вхід з вулиці  | `https://cdn.portcity.com.ua/mall/floor-0.png`     |
| `home-comfort`   | `null`                                                                                                                                                        | 2 поверх, ліве крило                     | `https://cdn.portcity.com.ua/mall/floor-2.png`     |
| `food-court`     | `{"mon":["10:00-22:00"],"tue":["10:00-22:00"],"wed":["10:00-22:00"],"thu":["10:00-22:00"],"fri":["10:00-23:00"],"sat":["10:00-23:00"],"sun":["10:00-22:00"]}` | 3 поверх, фуд-корт                       | `https://cdn.portcity.com.ua/mall/floor-3.png`     |

Для `intertop` у seed записати лише `{"exceptions":[...]}` (без днів тижня): у звичайні дні діють
години ТРЦ, 31.12 — скорочений день.

## 3. Рядок `mall_info` (id = 1)

Ідемпотентно: `prisma.mallInfo.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data })`.
Поля, що лишаються `null`, беруться з конфігурації (`MALL_ADDRESS`, `MALL_HOURS`, `SUPPORT_PHONE`,
`SUPPORT_EMAIL`).

```ts
const mallInfo = {
  address: null, // MALL_ADDRESS: «просп. Соборності, 43, Луцьк»
  hours: '10:00-22:00',
  telegramUrl: 'https://t.me/portcity_lutsk',
  infoDeskLocation: '1 поверх, центральний вхід',
  infoDeskHours: '10:00-22:00',
  parkingOperatorName: 'Оператор паркінгу ТРЦ «Порт City»',
  parkingOperatorPhone: '+380332000100',
  parkingOperatorHours: 'цілодобово',
  rulesPdfUrl: 'https://portcity.com.ua/docs/pravyla-trc.pdf',
  legalDocuments: [
    {
      key: 'program_rules',
      title: 'Правила програми лояльності',
      url: 'https://portcity.com.ua/docs/loyalty-rules.pdf',
    },
    {
      key: 'privacy',
      title: 'Політика конфіденційності',
      url: 'https://portcity.com.ua/docs/privacy.pdf',
    },
    {
      key: 'parking_rules',
      title: 'Правила користування паркінгом',
      url: 'https://portcity.com.ua/docs/parking-rules.pdf',
    },
  ],
  floorMapUrls: [
    { floor: 0, url: 'https://cdn.portcity.com.ua/mall/floor-0.png' },
    { floor: 1, url: 'https://cdn.portcity.com.ua/mall/floor-1.png' },
    { floor: 2, url: 'https://cdn.portcity.com.ua/mall/floor-2.png' },
    { floor: 3, url: 'https://cdn.portcity.com.ua/mall/floor-3.png' },
  ],
  parkingMapUrl: 'https://cdn.portcity.com.ua/mall/parking.png',
  supportPhone: null, // SUPPORT_PHONE
  supportEmail: null, // SUPPORT_EMAIL
  updatedById: null,
  updatedAt: now,
};
```

URL-и — заглушки до появи реальних файлів; зображення під префіксом `mall/` віддаються
`StoragePort.publicUrl()` як публічні.

## 4. Перевірка після seed

- `GET /api/v1/mall/info` -> `telegramUrl`, `infoDesk`, `parkingOperator`, `legalDocuments` (3),
  `floorMapUrls` (4), `parkingMapUrl`.
- `GET /api/v1/tenants/beauty-room` у неділю -> `isOpenNow: false`; `GET /api/v1/tenants/apteka-24`
  о 03:00 -> `isOpenNow: true`; `GET /api/v1/tenants/by-id/<id INTERTOP>` -> та сама картка.
