# Порт City — мобільний застосунок ТРЦ

Проєкт мобільного застосунку для ТРЦ «Порт City» (Луцьк, просп. Соборності, 43): паркінг, клубна картка з балами за чеки, винагороди й ваучери, акції та події, довідник ТРЦ. Паркінг — перший таб і стартовий екран застосунку.

## Що в репозиторії

| Тека / файл | Що це | Стан |
| --- | --- | --- |
| [`План_розробки_PortCity_App.md`](План_розробки_PortCity_App.md) | План розробки v1.2: обсяг, архітектура, етапи, оцінки, ризики, питання до клієнта | готовий |
| [`design/`](design/) | Клікабельний мобільний прототип: 56 екранів, паркінг першим, чорний стартовий екран | готовий, [відкрити на телефоні](https://claude.ai/artifact/2pyqr6TwnbcxfdJ6xkYsxN) |
| [`backend/`](backend/) | Бекенд лояльності: NestJS 12, Prisma 6, PostgreSQL 17, BullMQ; 10 модулів, 163 шляхи API | реалізовано й перевірено |
| `app/` | Мобільний застосунок на Flutter (iOS і Android) | ще не розпочато |

## Бекенд

Швидкий старт, архітектура та експлуатація — у [`backend/README.md`](backend/README.md), [`backend/docs/ARCHITECTURE.md`](backend/docs/ARCHITECTURE.md) і [`backend/docs/RUNBOOK.md`](backend/docs/RUNBOOK.md). Перелік ендпоінтів — [`backend/docs/API.md`](backend/docs/API.md).

Перевірено (01.11.2026): типізація, лінт, 3843 юніт-тести, 163 e2e-тести, збірка; на PostgreSQL 17.11 — три міграції, сид, 31 інтеграційний тест і живий сценарій API. Деталі — [`backend/docs/VERIFICATION.md`](backend/docs/VERIFICATION.md) і [`backend/docs/DB_VERIFICATION.md`](backend/docs/DB_VERIFICATION.md).

Продуктові рішення, ухвалені за замовчуванням, і відкриті питання до клієнта — [`backend/docs/INTEGRATION_NOTES.md`](backend/docs/INTEGRATION_NOTES.md).

CI: [`.github/workflows/backend.yml`](.github/workflows/backend.yml) запускається на зміни в `backend/`: лінт, типізація, юніт-тести, збірка, Docker-образ; потім міграції, сид, інтеграційні та e2e-тести на PostgreSQL 17 і Redis 7.

## Прототип

Прототип збирається з каркаса й фрагментів екранів: `python -X utf8 -I design/v2/assemble.py`. Структура теки й порядок змін — у [`design/README.md`](design/README.md). Перша версія прототипу лежить у `design/v1/` для порівняння.
