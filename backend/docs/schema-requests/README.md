# Запити на зміни схеми БД

Схема розділена на файли `prisma/schema/<module>.prisma`; кожен файл редагує лише власник модуля,
`base.prisma` (datasource, generator, спільні enum, OutboxEvent, IdempotencyKey, FeatureFlag, AuditLog)
належить schema-агенту. Модулю потрібна зміна в чужому файлі (нове поле, індекс, enum, зв'язок):

1. Створіть `docs/schema-requests/<module>-<n>.md` (наприклад `receipts-1.md`) з полями:
   - Файл і модель, яку треба змінити.
   - Пропонований фрагмент Prisma-схеми.
   - Причина (який запит або інваріант цього потребує).
   - Вплив на міграцію (чи потрібне заповнення даних, чи ламається сумісність).
2. До виконання запиту пишіть код проти поточної схеми; тимчасові дані можна тримати в `jsonb`-полі
   власної моделі або читати через сервіс власника.
3. Власник файлу або integration-агент застосовує зміну, оновлює міграцію і закриває запит рядком
   `Статус: застосовано <дата>` або `Статус: відхилено, причина`.

Правила для будь-якої зміни схеми: id `String @id @db.Uuid`, гроші `Int` у копійках, час
`DateTime @db.Timestamptz(6)`, таблиці та колонки у snake_case через `@map/@@map`, індекси з BRIEF розділ 5.

English summary: one owner per schema file; cross-module schema changes are requested here with the
proposed Prisma fragment and applied by the owner or the integration agent.
