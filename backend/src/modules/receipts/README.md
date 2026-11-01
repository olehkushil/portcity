# Модуль receipts (чеки)

Подання фіскальних чеків за QR-кодом податкової або вручну з фото, правила ризику й
автоматичного схвалення, захист від підроблених і повторно поданих чеків, нарахування балів через
клуб, модерація в бек-офісі та оскарження. Джерело вимог: `docs/BRIEF.md`, розділи 3-9; екрани
прототипу `scan-result`, `scan-pending`, `scan-rejected`.

## Структура

| Шлях                                         | Що там                                                                                          |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `domain/qr-parser.ts`                        | парсер URL `cabinet.tax.gov.ua/cashregs/check` (ніколи не кидає нічого, крім `QrParseError`)    |
| `domain/fiscal-ids.ts`                       | канонічні номери: `canonicalFiscalId()` (номер чека) і `canonicalFn()` (номер каси)             |
| `domain/rules.ts`                            | правила ризику, автосхвалення, шаблони шахрайства, денний ліміт балів, утримання на перевірку   |
| `domain/state-machine.ts`                    | машина станів чека, ліміт оскаржень (1 на чек)                                                  |
| `domain/submission-view.ts`                  | який екран показати застосунку та українські тексти                                            |
| `domain/photo.ts`, `domain/manual-input.ts`  | правила фото (тип, розмір, ключ власника) і розбір дати ручного чека                            |
| `services/receipt-pipeline.service.ts`       | конвеєр uploaded -> parsed -> рішення -> credited, спільний для запиту і черги                  |
| `services/receipt-submission.service.ts`     | подання QR/вручну, URL для фото, мої чеки, оскарження                                           |
| `services/receipt-moderation.service.ts`     | черга модерації, перегляд (аудит), approve (з дозаповненням `fn`) / reject (аудит)              |
| `services/receipt-verification.service.ts`   | задача `verify-held`: повторна перевірка чеків в утриманні, сторно при відмові                  |
| `services/tax-receipt-verifier.ts`           | `TaxReceiptVerifierPort` і адаптер-заглушка `NoopTaxReceiptVerifier` (завжди `unknown`)         |
| `services/expected-points.service.ts`        | «очікувані бали» неврегульованих чеків за тією самою формулою                                   |
| `services/receipts-port.service.ts`          | реалізація `RECEIPTS_PORT`                                                                      |
| `services/receipts.repository.ts`            | доступ Prisma лише до таблиць `receipts`, `receipt_events`, `receipt_appeals`                   |
| `jobs/receipts-process.*`                    | черга `receipts-process`: логіка-функція з тестом і процесор-обгортка                           |
| `controllers/`                               | `ReceiptsController` (`/receipts`), `AdminReceiptsController` (`/admin/receipts`)               |

## Модель даних (`prisma/schema/receipts.prisma`)

- `Receipt`: `fn` (канонічний фіскальний номер РРО; `null` лише для ручного чека, поданого з
  магазином, але без номера каси), `fiscalId` (канонічний номер чека), `fnRaw` / `fiscalIdRaw`
  (як подав учасник, для аудиту), `issuedAt` (UTC), `totalKopecks`, `rawQr` (текст QR як
  відскановано), `source` (`qr | manual`), `photoKey`, `tenantId`, `status`, `riskFlags` (jsonb),
  `riskScore` 0-100, `moderationReasons` (jsonb масив причин модерації, див. нижче),
  `rejectionCode` (код правила, що відхилило чек; `null` для рішень модератора), `moderatorId`,
  `decisionReason`, `decidedAt`, `pointsAwarded`, `pointsTxId`, `verification`
  (`not_required | pending | confirmed | rejected | unconfirmed`), `verifyUntil`,
  `verificationCheckedAt`, `submittedAt`.
  Унікальність `(fn, fiscalId)` — на канонічних значеннях у всій програмі (рядки з `fn = NULL` не
  конфліктують, дубль ловиться, коли модератор дозаповнює `fn`). CHECK
  `receipts_fn_required_for_qr`: `fn IS NOT NULL OR source = 'manual'`.
- `ReceiptEvent`: історія переходів (`fromStatus`, `toStatus`, `actorType system|user|admin`,
  `actorId`, `note`).
- `ReceiptAppeal`: оскарження (`message`, `photoKey`, `resolvedAt`, `resolvedById`, `resolution`).

Зміни схеми й заповнення даних для наявних рядків — міграція
`prisma/schema/migrations/20261101180000_review_fixes` (розділи 1, 2.4 і 4); seed — `prisma/seed.ts`.
Архів початкових файлів — `docs/pending-sql/applied/receipts-content.*`.

### Канонічні номери (один чек — одне нарахування)

Раніше той самий чек можна було зарахувати кілька разів, переписавши номер (`id=1180000001`,
`01180000001`, `001180000001`, регістр літер, дефіси). Тепер парсер QR і ручна форма зводять номери
до канонічного вигляду, і унікальний ключ `(fn, fiscal_id)` зберігає саме його:

- номер чека (`canonicalFiscalId`): обрізати пробіли, верхній регістр, прибрати пробіли й дефіси
  (також юнікод-тире), у суто цифрових номерах прибрати провідні нулі (`0000` -> `0`); результат —
  1-64 латинські літери або цифри (кирилиця-двійник не «згортається», а відхиляється);
- номер каси (`canonicalFn`, спільна `canonicalFiscalNumber` у `src/common/contracts/content.ts`):
  лише цифри, без роздільників і провідних нулів, 6-20 цифр. Білий список content використовує ту
  саму функцію, тож пошук каси і ключ чека завжди збігаються.

Сирий текст QR (`rawQr`) і сирі номери (`fnRaw`, `fiscalIdRaw`) зберігаються для аудиту й видні
в `GET /admin/receipts/:id`. Наявні рядки канонізує міграція `20261101180000_review_fixes`
(розділ 4b; звіт після деплою - `docs/RUNBOOK.md`):
найстаріший чек лишається, пізніші копії записуються в `receipt_canonical_collisions`, відкриті
копії стають `rejected` з `PC_RECEIPT_DUPLICATE`, а вже зараховані позначаються
`credited_needs_reversal` — їхні бали треба сторнувати через леджер клубу.

## Машина станів

```
uploaded -> parsed -> auto_approved -> credited
                  \-> needs_moderation -> approved -> credited
                  |                    \-> rejected(reason) -> appealed -> needs_moderation
                  \-> rejected (правило: застарий, з майбутнього, виключений магазин, сума)
auto_approved -> needs_moderation   (система: денний ліміт балів вичерпав паралельний чек)
credited -> rejected                (система: податкова перевірка відхилила чек під час утримання)
```

Рядок створюється одразу в `parsed`; історія все одно містить `null -> uploaded` (учасник) і
`uploaded -> parsed` (система). Кожен крок конвеєра — окрема коротка транзакція з оптимістичною
перевіркою статусу (`UPDATE ... WHERE status = <очікуваний>`), тому синхронний шлях і черга не
конфліктують.

## Потік подання

1. `POST /receipts/qr`: розбір QR (`PC_RECEIPT_QR_INVALID` 400 з українським `detail` і
   `details.reason` = `NOT_A_TAX_URL | MISSING_PARAM | BAD_DATE | BAD_SUM`), канонізація номерів.
2. Перевірка дубля `(fn, fiscalId)` на канонічних значеннях -> `PC_RECEIPT_DUPLICATE` 409 (id
   наявного чека отримує лише його власник). Гонка двох запитів закривається унікальним індексом.
3. Транзакція: `Receipt(parsed)` + 2 події + outbox `receipt.submitted` (для ручного чека без каси
   `fn = ''` у payload).
4. Правила (`domain/rules.ts`) з даними з портів і власної таблиці:
   - `CONTENT_PORT.findTenantByFiscalNumber(fn)` — білий список кас; невідома каса реєструється
     через `recordSeenFiscalNumber(fn, tx, { receiptId })`; для ручного чека без каси — магазин,
     обраний учасником;
   - `CONTENT_PORT.isExcluded`, `getTenantRule` — виключення й ставка;
   - `CLUB_LEDGER_PORT.getActiveRules()` — пороги набору правил;
   - лічильники: чеки за київську добу, серія з однієї каси за 10 хв, той самий пристрій в іншого
     учасника за 24 год, бали за QR-чеки за добу, шаблони шахрайства (нижче);
   - `TaxReceiptVerifierPort.verify()` для QR-чеків (помилка перевірки = `unknown`).
5. Рішення:
   - `rejected` (`PC_RECEIPT_TOO_OLD`, `PC_RECEIPT_FUTURE`, `PC_RECEIPT_EXCLUDED_TENANT`,
     `PC_RECEIPT_TOTAL_INVALID`) — outbox `receipt.rejected` з `code`;
   - `needs_moderation` — причини в `moderationReasons`, outbox `receipt.needs_moderation`;
   - `auto_approved` — одразу нарахування.
6. Нарахування (транзакція під `pg_advisory_xact_lock(hashtext(userId))`): після блокування
   читаються бали учасника в магазині за добу (ліміт магазину `dailyCapPoints`), ознака першого
   чека і бали за QR-чеки за добу — паралельні чеки того самого учасника більше не обходять
   ліміти. `floor(сума грн * ставка %)`, ставка правила магазину > override > базова 3 %, максимум
   500 балів. Утримання (`CLUB_LEDGER_PORT.hold`, стан `pending`) — якщо сума > 3 000 грн (7 днів)
   або діє утримання на перевірку (24 год, нижче); довше з двох перемагає. Ключ леджера
   `receipt:<receiptId>` (`receipt:<id>:reinstated` для повторного нарахування після сторно за
   податковою перевіркою). У леджер передаються дані для історії: `title` «Нарахування за чек»,
   `subtitle` «INTERTOP · 450,50 ₴», `counterparty { tenantId, tenantName, receiptId,
   receiptTotalKopecks }`. Якщо ліміт магазину вичерпано, чек стає `credited` з 0 балів.
7. Якщо будь-який крок 4-6 падає (порт недоступний), чек лишається в `parsed`/`auto_approved`, а в
   чергу `receipts-process` ставиться задача; відповідь — екран «на перевірці».

### Причини модерації (`moderationReasons`)

`manual_submission`, `fn_not_whitelisted`, `fn_blocked`, `total_above_threshold`,
`daily_limit_reached`, `same_fn_burst`, а також:

| Причина                  | Коли                                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------------- |
| `daily_points_cap`       | бали учасника за QR-чеки сьогодні + цей чек > `RECEIPTS_DAILY_POINTS_CAP` (лише коли інших причин немає) |
| `same_total_other_user`  | інший учасник подав чек з тією самою сумою з тієї самої каси за останні 24 год                        |
| `round_total_repeat`     | сума кратна 100 грн, і учасник уже подавав «круглу» суму за останні 30 днів                           |
| `fiscal_id_out_of_order` | номер чека каси суперечить часу: менший номер пізніше за більший (або навпаки), допуск 1 хв          |
| `tax_check_failed`       | `TaxReceiptVerifierPort` відповів `rejected`                                                          |

Учасник бачить для шаблонів шахрайства одну нейтральну причину «Чек потребує додаткової перевірки»
(евристики не розкриваються); модератор бачить коди. Відхилені чеки в шаблонах не враховуються.

## Захист від підроблених чеків

Податкова не має публічного API перевірки чека, а `mac` QR-коду не перевіряється офлайн, тож
підроблений QR (справжня каса + вигаданий номер і сума) виглядає як справжній. Заходи:

1. **Утримання на перевірку.** Автосхвалений QR-чек нараховується як `pending` з
   `availableAt = now + RECEIPTS_VERIFY_HOLD_HOURS` (24 год), якщо акаунт молодший за
   `RECEIPTS_NEW_ACCOUNT_DAYS` (30 днів; вік — `IDENTITY_PORT.getUser().createdAt`, невідомий вік =
   новий акаунт) або сума > `RECEIPTS_FAST_TRACK_MAX_KOPECKS` (500 грн). Старі акаунти з дрібними
   чеками отримують бали одразу. Схвалення модератором і ручні чеки не утримуються. Чек отримує
   `verification = pending` і `verifyUntil`.
2. **Денний ліміт балів за QR-чеки** (`RECEIPTS_DAILY_POINTS_CAP`, 150): чек, що перевищив би
   ліміт, іде на модерацію; ліміт перевіряється вдруге під блокуванням учасника перед нарахуванням
   (`auto_approved -> needs_moderation`, якщо паралельний чек устиг першим).
3. **Шаблони шахрайства** (таблиця вище) примусово відправляють чек на модерацію.
4. **`TaxReceiptVerifierPort`.** Викликається під час рішення (`confirmed` знімає утримання,
   `rejected` -> модерація) і задачею `verify-held` кожні 30 хв для чеків в утриманні:
   `confirmed` -> `verification = confirmed` (бали відпускає клуб у `availableAt`), `rejected` ->
   `CLUB_LEDGER_PORT.reverse()` (pending -> cancelled, ключ `receipt-unverified:<id>`), чек
   `credited -> rejected` з `PC_RECEIPT_NOT_VERIFIED` і outbox `receipt.rejected` (оскарження
   дозволене), `unknown` -> повторити, після `verifyUntil` — `unconfirmed`. Типовий адаптер
   `NoopTaxReceiptVerifier` завжди відповідає `unknown`.

**Залишковий ризик.** Поки немає справжньої перевірки в податковій, підроблений чек старого акаунта
до 500 грн з каси з білого списку, з неокруглою сумою, номером у правдоподібному порядку і в межах
денного ліміту зараховується одразу; для нових акаунтів і великих сум утримання лише відкладає
доступність балів на 24 год, але без перевіряльника нічого не відхилить автоматично. Максимальний
збиток на акаунт — `RECEIPTS_DAILY_POINTS_CAP` балів на добу (150 = 150 грн за `pointValueKopecks`
100); масові атаки обмежують ліміти чеків, шаблон `same_total_other_user` і `device_shared`.
Шаблони дають хибні спрацювання (два квитки в кіно на одну суму, «круглі» ціни) — лише модерація,
не відхилення. Рекомендації: підключити адаптер перевірки (угода з ДПС або оператор фіскальних
даних), стежити за звітом модерації за причинами, налаштувати пороги через змінні середовища.

## Відповідь застосунку (`ReceiptSubmissionResultDto`)

| `screen`   | Екран прототипу | `outcome`                    | Що ще в відповіді                                                       |
| ---------- | --------------- | ---------------------------- | ----------------------------------------------------------------------- |
| `credited` | `scan-result`   | `credited` або `held`        | `pointsAwarded`, `pointsAvailableAt` (для `held`), `balance` після нарахування |
| `pending`  | `scan-pending`  | `needs_moderation`           | `moderationReasons` українською, `receipt.expectedPoints`               |
| `pending`  | `scan-pending`  | `processing`                 | бали ще нараховуються чергою (`parsed`, `auto_approved`, `approved`)     |
| `rejected` | `scan-rejected` | `rejected`                   | `rejectionCode`, `message` «Відхилено: ... оскаржте ...»                 |

`ReceiptDto.expectedPoints` — очікувані бали для чеків на модерації або в обробці (`uploaded`,
`parsed`, `auto_approved`, `needs_moderation`, `approved`, `appealed`) за тією самою формулою, що й
нарахування (без денних лімітів і рішення модератора); `null` для врегульованих чеків, 0 для
виключеного магазину.

## Ендпоїнти (префікс `/api/v1`)

Учасник (`@Auth('member')`):

| Метод і шлях                       | Опис                                                                                     |
| ---------------------------------- | ---------------------------------------------------------------------------------------- |
| `POST /receipts/qr`                | `{qrText}`, обов'язковий `Idempotency-Key`; 30 запитів / 10 хв                           |
| `POST /receipts/manual`            | обов'язковий `Idempotency-Key`; `{tenantId?, fn?, fiscalId, issuedAt, totalKopecks, photoKey}`: `tenantId` — магазин з форми (`null` = «Не знаю»), `fn` необов'язковий, якщо обрано магазин (модератор дозаповнить), `fiscalId` обов'язковий; пробіли, дефіси, регістр і провідні нулі не важать; 10 / 10 хв |
| `POST /receipts/photo-upload-url`  | `{contentType, sizeBytes}`: лише `image/jpeg`, `image/png`, `image/heic`, до 5 МБ; presigned PUT |
| `GET /receipts`                    | мої чеки, нові спершу, `?status=&from=&to=&cursor=&limit=` (`from`/`to` — `submittedAt`, ISO 8601, `to` не включно); `expectedPoints` |
| `GET /receipts/:id`                | деталі: бали з леджера, історія, оскарження, підписане посилання на фото (до 1 год), причини модерації, `expectedPoints` |
| `POST /receipts/:id/appeal`        | `{message, photoKey?}`: лише `rejected`, один раз; `rejected -> appealed`                |

Бек-офіс (`@Auth('admin', 'moderator', 'manager', 'support')`, `owner` проходить завжди):

| Метод і шлях                         | Ролі                    | Опис                                                                      |
| ------------------------------------ | ----------------------- | ------------------------------------------------------------------------- |
| `GET /admin/receipts?status=`        | moderator, manager, support | список; черга (`needs_moderation`, `appealed`) від найстаріших; фільтри `userId`, `fn` (канонізується), `reason`, `from`, `to`, `order`; кожен рядок має `moderationReasons`, `rejectionCode`, `verification`, `verifyUntil`, `expectedPoints` |
| `GET /admin/receipts/:id`            | moderator, manager, support | деталі з `riskFlags`, причинами, історією, оскарженнями, `rawQr`, `fnRaw`, `fiscalIdRaw`, підписаними URL фото; перегляд пишеться в аудит (`receipt.view`) |
| `POST /admin/receipts/:id/approve`   | moderator, manager      | `{reason?, fn?}`, `Idempotency-Key`; `fn` обов'язковий для ручного чека без каси (канонізується, мапить магазин через білий список, невідома каса йде в чергу зіставлення; дубль -> `PC_RECEIPT_DUPLICATE` 409); `needs_moderation` або `appealed` -> `approved` -> `credited`; аудит `receipt.approve` |
| `POST /admin/receipts/:id/reject`    | moderator, manager      | `{reason}` (показується учаснику); аудит `receipt.reject` у транзакції     |

## Помилки (`domain/errors.ts`)

`PC_RECEIPT_QR_INVALID` 400, `PC_RECEIPT_DUPLICATE` 409, `PC_RECEIPT_NOT_FOUND` 404,
`PC_RECEIPT_INVALID_TRANSITION` 409, `PC_RECEIPT_APPEAL_NOT_ALLOWED` 422,
`PC_RECEIPT_PHOTO_REQUIRED` 422, `PC_RECEIPT_PHOTO_INVALID` 422, `PC_RECEIPT_MANUAL_DISABLED` 403,
`PC_RECEIPT_NOT_VERIFIED` 422 (код правила: податкова перевірка відхилила чек). Коди правил
(`TOO_OLD`, `FUTURE`, `EXCLUDED_TENANT`, `TOTAL_INVALID`, `NOT_VERIFIED`, а також `DUPLICATE` для
копій, відхилених заповненням даних) повертаються в `rejectionCode`, а не як HTTP-помилки. Ручна
форма: `PC_COMMON_VALIDATION` 400 з `details.field` (`fn` + `reason: required_without_tenant`,
`tenantId` + `reason: not_found`, `fiscalId`).

## Події outbox (`receipt.*`)

| Подія                       | Коли                                                     |
| --------------------------- | -------------------------------------------------------- |
| `receipt.submitted`         | чек збережено                                            |
| `receipt.needs_moderation`  | правила (або повторна перевірка ліміту) відправили на модерацію |
| `receipt.rejected`          | правило (`code` заповнений, зокрема `PC_RECEIPT_NOT_VERIFIED`) або модератор (`moderatorId`) |
| `receipt.approved`          | модератор схвалив (для автосхвалення не публікується)    |
| `receipt.credited`          | бали нараховано або утримано (`pointsState`, `firstReceipt`) |
| `receipt.appealed`          | учасник подав оскарження                                 |

Споживає (черга `receipts-events`): `user.deleted` — фото чеків і оскаржень видаляються зі
сховища, ключі фото обнуляються, тексти оскаржень замінюються плейсхолдером; фіскальні дані
лишаються для перевірки дублів. Логіка — `handleReceiptsEventJob` (юніт-тест).

## Черга `receipts-process`

- `process {receiptId}` — `ReceiptPipelineService.process()`; 3 спроби, експоненційна затримка
  від 5 с; `jobId = receipt-<id>-<тег>`.
- `sweep` — розклад `receipts-process-sweep` кожні 10 хв: до 100 чеків, що застрягли в
  `uploaded|parsed|auto_approved|approved` довше `RECEIPTS_STUCK_AFTER_MINUTES`.
- `verify-held` — розклад `receipts-verify-held` кожні 30 хв: до 100 чеків з
  `verification = pending` (найдовше не перевірені першими) -> `ReceiptVerificationService`.
- Логіка — функція `handleReceiptsProcessJob` (тест); `ReceiptsProcessProcessor` лише з'єднує.

## Порти

- Надає: `RECEIPTS_PORT` (`getReceipt`, `countForUser`, `getDailyStats`,
  `getPendingSummary(userId) -> { count, expectedPoints }` — чеки на модерації та в обробці і
  очікувані бали для картки клубу) -> `ReceiptsPortService`.
- Споживає: `CONTENT_PORT`, `CLUB_LEDGER_PORT`, `IDENTITY_PORT` (лише `getUser().createdAt` для
  віку акаунта; identity — листок графа, циклу немає), глобальні `ADMIN_AUDIT_PORT`,
  `FEATURE_FLAGS_PORT`, `StoragePort`, `OutboxService`, `Clock`; `TaxReceiptVerifierPort`
  (абстрактний клас-токен, типово `NoopTaxReceiptVerifier`; справжній адаптер підміняє провайдер
  у `receipts.module.ts`).
- Таблиці інших модулів не читаються: `device_shared` рахується за `receipts.device_id`.
- Фото чеків — приватні об'єкти (`receipts/<userId>/...`): лише підписані посилання до 1 год,
  ніколи не постійний публічний URL (`StoragePort.publicUrl()` для них повертає `null`).

## Змінні середовища (секція `receipts`, `receipts.config.ts`)

| Змінна                              | Типово          | Опис                                                         |
| ----------------------------------- | --------------- | ------------------------------------------------------------ |
| `RECEIPTS_PHOTO_MAX_BYTES`          | 5242880 (5 МБ)  | максимальний розмір фото (не більше 5 МБ)                    |
| `RECEIPTS_PHOTO_UPLOAD_TTL_SECONDS` | 600             | час життя presigned PUT                                      |
| `RECEIPTS_PHOTO_URL_TTL_SECONDS`    | 900             | час життя підписаних посилань на фото (60-3600)              |
| `RECEIPTS_STUCK_AFTER_MINUTES`      | 5               | через скільки хвилин незавершений чек підхоплює `sweep`      |
| `RECEIPTS_VERIFY_HOLD_HOURS`        | 24              | утримання автосхвалених QR-чеків на перевірку (0 — вимкнено) |
| `RECEIPTS_NEW_ACCOUNT_DAYS`         | 30              | акаунт молодший за це — утримання на кожен QR-чек            |
| `RECEIPTS_FAST_TRACK_MAX_KOPECKS`   | 50000 (500 грн) | QR-чек із сумою понад це — утримання на будь-якому акаунті   |
| `RECEIPTS_DAILY_POINTS_CAP`         | 150             | бали за автосхвалені QR-чеки на учасника за київську добу    |

Нові змінні треба додати в `.env.example` (файл інтеграції; `env-example.spec.ts` перевіряє
повноту).

## Тести

- `npx jest src/modules/receipts` — домен (парсер QR понад 50 випадків плюс фазинг і варіанти
  переписаних номерів, канонічні номери, правила й шаблони шахрайства, утримання на перевірку,
  машина станів, екрани, фото, дата ручного чека, DTO ручної форми), сервіси з фейками портів
  (`test/receipts/support/`: in-memory репозиторій з відкатом транзакцій, фейкові леджер,
  content, identity, перевіряльник податкової, аудит, прапорці, outbox, черга, сховище),
  анти-фрод (`receipt-anti-fraud.spec.ts`), задача `verify-held`, порт (`getPendingSummary`).
- `npx jest --config test/jest-e2e.config.js test/receipts` — збірка всього `AppModule` без БД:
  DI модуля (включно з noop-перевіряльником), розклади, маршрути, гарди й ролі, валідація,
  `Idempotency-Key` для QR і ручного подання, presigned upload.
- Інтеграційних тестів із PostgreSQL модуль поки не має (див. відкриті питання).

## Відкриті питання

1. `device_shared` не бачить перевстановлень застосунку (fingerprint пристрою належить identity).
2. Повторне оскарження заборонене (рішення після оскарження остаточне) — підтвердити з бізнесом.
3. Справжній `TaxReceiptVerifierPort` (угода з ДПС або оператор фіскальних даних) — без нього
   утримання лише відкладає бали (див. «Залишковий ризик»).
4. Пороги шаблонів шахрайства (крок «круглої» суми 100 грн, вікна 24 год / 30 днів, допуск порядку
   номерів 1 хв) — константи в `domain/rules.ts`; винести в набір правил клубу після пілота.
5. Чи сторнувати автоматично бали за `credited_needs_reversal` з заповнення даних (зараз — звіт
   для ручного коригування).
6. Інтеграційний тест репозиторію з PostgreSQL (`describeWithDb`, зокрема `pg_advisory_xact_lock`)
   — ще не написаний.

Закрито 2026-11-01 (рев'ю): канонічні номери й ключ `(fn, fiscal_id)`, утримання на перевірку,
денний ліміт балів за QR, шаблони шахрайства, `TaxReceiptVerifierPort` + `verify-held`, гонка
денного ліміту магазину (блокування учасника), `Idempotency-Key` для ручного подання (раніше
відкрите питання 3), ручна форма з магазином і без каси, `expectedPoints` і фільтри `from`/`to`,
дані для історії в леджері, `getPendingSummary`.

---

English summary: receipts module. QR and manual (photo) submission with canonical fiscal ids
(trim, upper case, no spaces or dashes, numeric ids and fn without leading zeros) stored in the
`(fn, fiscal_id)` unique key, raw values kept for audit. Anti-fraud: verification hold (pending
credit for 24 h on new accounts or totals above 500 UAH), a daily QR points cap re-checked under a
per-member advisory lock, fraud patterns that force moderation (same total and fn from another
member within 24 h, repeated round totals, out-of-order receipt numbers), and a
`TaxReceiptVerifierPort` (noop: unknown) called during the decision and by the `verify-held` job,
whose rejection reverses the pending points through the ledger. Credits pass display data
(title, subtitle, counterparty) to CLUB_LEDGER_PORT; the tenant daily cap and first-receipt flag
are computed inside the credit transaction after `pg_advisory_xact_lock(hashtext(userId))`.
`POST /receipts/manual` is idempotent and accepts a tenant without fn (the moderator fills fn in
on approval). `ReceiptDto.expectedPoints`, `GET /receipts?from&to`, RECEIPTS_PORT
`getPendingSummary`. Residual risk documented above.
