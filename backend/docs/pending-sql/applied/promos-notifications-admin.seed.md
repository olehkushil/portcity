> **Застосовано (архів).** Внесено в `prisma/seed.ts` 01.11.2026 (схема - міграцією
> `20261101180000_review_fixes`): `category` акцій, нові поля демо-події (masterclass, Figli Migli,
> 4-10 років, до 4 осіб), друга подія `event:cinema-autumn` (зовнішній вхід), прапорець
> `events.registration` з `maxPersonsPerRegistration: 4`, у development - нумерація звернень з
> № 1042. Не внесено: `imageKey` акцій і подій (немає файлів у бакеті).

# Зміни seed для promos / notifications / admin (2026-11-01)

Застосовує integration-агент у `prisma/seed.ts` (модульні агенти seed не редагують). Схема й SQL -
`docs/pending-sql/promos-notifications-admin.sql`. Усі upsert лишаються ідемпотентними.

## 1. Акції (`seedPromos`)

Нове поле `category` (enum `PromoCategory`: `fashion | food | entertainment | kids | beauty |
electronics | other`, типово `other`) - чіпси списку акцій у прототипі (Одяг і взуття, Їжа, Розваги,
Діти, Краса).

| Акція (`seedId`)                  | `category` | `imageKey` (необов'язково)     |
| --------------------------------- | ---------- | ------------------------------ |
| `promo:intertop-20` (INTERTOP)    | `fashion`  | `promos/seed/intertop-20.jpg`  |
| `promo:aroma-1plus1` (Aroma Kava) | `food`     | `promos/seed/aroma-1plus1.jpg` |

Додати `category` в об'єкти `intertopPromo` і `aromaPromo` (і в `create`, і в `update`).
`imageKey` має сенс лише разом із завантаженим файлом у бакеті та `S3_PUBLIC_BASE_URL`; без них
відповідь API дає `imageUrl: null`, тож рядок можна пропустити.

## 2. Подія (`seedEvent`, `event:kids-workshop`)

Нові поля (решта без змін):

```ts
category: 'masterclass' as const,      // чіпс «Майстер-класи»; для дитячого фільтра є 'kids'
tenantId: requireId(tenants, 'figli-migli'),
admission: 'registration' as const,
externalUrl: null,
maxPersonsPerRegistration: 4,          // прототип: «До 4 учасників на одну реєстрацію»
ageMin: 4,                             // з опису «для дітей 4-10 років»
ageMax: 10,
ageLimit: 4,                           // лишається для сумісності (дорівнює ageMin)
imageKey: 'events/seed/kids-workshop.jpg', // необов'язково, див. примітку до акцій
```

`seedEvent` зараз не отримує мапу орендарів: передати `tenants` так само, як у `seedPromos`
(`await seedEvent(tenants, now)`).

Увага щодо ліміту осіб. Прапорець `events.registration` у seed має payload
`{ maxPersonsPerRegistration: 6 }`. Раніше код його ігнорував (жорстко 4), тепер це типове значення
для подій без власного `maxPersonsPerRegistration`. Для демо-події вище стоїть явне 4 (як у
прототипі). Якщо замовник хоче 4 скрізь - змінити payload прапорця на 4.

## 3. Друга демо-подія (рекомендовано для фільтрів і зовнішнього входу)

```ts
{
  id: seedId('event:cinema-autumn'),
  title: 'Кінопоказ «Осінь у місті»',
  description: 'Сеанси й квитки - на сайті Premier City.',
  startsAt: <наступна неділя 18:00 Київ>,
  endsAt: startsAt + 2 год,
  venue: 'Premier City, 3 поверх',
  category: 'cinema',
  tenantId: requireId(tenants, 'premier-city'),
  admission: 'external',
  externalUrl: 'https://premiercity.com.ua/',
  capacity: null,
  registrationOpen: false,
  maxPersonsPerRegistration: null,
  ageMin: null, ageMax: null, ageLimit: null,
  status: 'published',
}
```

CHECK `events_external_admission_url_check` вимагає `externalUrl` для `admission = 'external'`.
Slug орендаря кінотеатру в seed - `premier-city`.

## 4. Звернення в підтримку

Демо-даних не потрібно. Послідовність `support_request_number_seq` стартує з 1001 (SQL B.1). Для
демо, що повторює прототип («Звернення № 1042 прийнято»), можна виконати
`SELECT setval('support_request_number_seq', 1041);` - лише в dev-базі.

## 5. Ручні коригування

Нічого не додавати. Якщо seed колись створюватиме `manual_adjustments`, рядки понад поріг мають
`secondApprovalReason: 'amount'`; самостійно затверджені - `null` (вони рахуються в кумулятивний
ліміт «чотирьох очей»).

## 6. Змінні середовища для демо

`SUPPORT_EMAIL=support@portcity.local` (лист про звернення йде через `MAIL_PROVIDER=log`, тобто в лог),
`S3_PUBLIC_BASE_URL` - якщо потрібні `imageUrl` акцій і подій.
