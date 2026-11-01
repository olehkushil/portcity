# Запити на залежності

`npm install` можуть виконувати лише foundation- та integration-агенти: паралельні встановлення
псують `package-lock.json`. Модульний агент, якому потрібен пакет, якого ще немає в `package.json`:

1. Створює файл `docs/deps-requests/<module>.md` (наприклад `receipts.md`) з таблицею:

   | Пакет   | Версія  | Навіщо                                        | Альтернатива без пакета                   |
   | ------- | ------- | --------------------------------------------- | ----------------------------------------- |
   | `sharp` | `^0.34` | стиснення фото чеків перед завантаженням у S3 | зберігати оригінал, стискати в застосунку |

2. Пише код так, ніби пакета немає: використовує наявні залежності або залишає порт з in-memory
   реалізацією і `TODO(deps: <пакет>)` у коді.
3. Integration-агент переглядає запити, виконує `npm install`, оновлює lockfile і закриває запит,
   додаючи рядок `Статус: встановлено <дата>` або `Статус: відхилено, причина`.

Що вже є (не запитувати): NestJS 12 (`common`, `core`, `platform-express`, `config`, `swagger`, `bullmq`,
`terminus`, `throttler`, `testing`), Prisma 6.19, BullMQ 6, ioredis 5, zod 4, class-validator,
class-transformer, nestjs-pino, pino, helmet, date-fns 4, `@date-fns/tz`, uuidv7, libphonenumber-js,
`@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, otplib 13, jest 30, `@swc/jest`, supertest.

English summary: module agents must not run `npm install`; they file a request here and code against
what is already in `package.json`.
