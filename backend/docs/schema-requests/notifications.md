# notifications-1: колонка `dedupeKey` у `Notification`

- Файл і модель: `prisma/schema/notifications.prisma`, модель `Notification`.
- Пропонований фрагмент:

  ```prisma
  model Notification {
    // ...
    /// NotifyInput.dedupeKey (outbox event id, reminder id); replays return the existing row.
    dedupeKey String? @map("dedupe_key") @db.VarChar(200)
    // ...
    @@unique([userId, dedupeKey])
  }
  ```

- Причина: контракт `NotifyInput.dedupeKey` вимагає ідемпотентності споживачів outbox за `eventId`
  (`docs/FOUNDATION_SUMMARY.md`, розділ 5). Зараз ключ лежить у `data._dedupeKey`, пошук іде через
  JSON-path (`data->>'_dedupeKey'`) без індексу, а паралельні доставки однієї події теоретично можуть
  створити дубль (немає унікального обмеження). Колонка з унікальним індексом робить повтор
  дешевим і атомарним (`ON CONFLICT DO NOTHING` / перехоплення P2002).
- Вплив на міграцію: нова nullable-колонка; заповнення
  `UPDATE notifications SET dedupe_key = data->>'_dedupeKey' WHERE data ? '_dedupeKey'`; потім
  унікальний індекс. Код зміниться в одному місці (`services/notifications.service.ts`,
  `findByDedupeKey` і `buildStoredData`), API не змінюється.
- Статус: застосовано 2026-11-01 (integration): колонка `dedupe_key` + `@@unique([userId, dedupeKey])`, заповнення з `data._dedupeKey` (дублікати лишають ключ лише найстарішому рядку), ключ прибрано з `data`.

English summary: add `Notification.dedupeKey` with a unique `(userId, dedupeKey)` index instead of
storing the dedupe key inside the `data` JSON.
