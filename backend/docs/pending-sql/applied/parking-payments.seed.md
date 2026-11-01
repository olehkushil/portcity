> **Застосовано (архів).** Внесено в `prisma/seed.ts` 01.11.2026 (схема - міграцією
> `20261101180000_review_fixes`): `label` демо-авто, `paidUntil`/`outcome`/`outcomeAt`/`registeredAt`
> посилання на демо-платіж і `paidUntil`/`plate`/`plateDisplay` у `meta` платежу.

# Seed notes: parking + payments review fixes

Для інтеграційного агента: зміни до `prisma/seed.ts` (цей агент seed не редагує). Усі пункти
необов'язкові для роботи коду - лише щоб демо-дані показували нові поля.

1. **Назва демо-авто** (`vehicles.label`, finding 14): демо-учаснику `+380501234567` для авто
   `AC1234BC` поставити `label: 'Моє авто'` (колонка nullable; без неї авто просто без назви).

2. **Оплачений демо-платіж** (сценарії `paid` / `closed`, `prisma/seed.ts` біля
   `idempotencyKey: 'seed:demo:parking-payment'`):
   - у `parkingPaymentLink.upsert` (create і update) додати `paidUntil: at(16, 0)`,
     `outcome: 'applied'`, `outcomeAt: at(15, 20)`, `registeredAt: at(15, 20)` (findings 2 і 4).
     Інакше 5-хвилинна задача `payments-sweep` протягом 48 год вважатиме платіж
     незастосованим і повторить `applyPaymentSucceeded` (ідемпотентно, але зайвий виклик
     оператора);
   - у `meta` платежу додати `paidUntil: at(16, 0).toISOString()`, `plate: 'AC1234BC'`,
     `plateDisplay: 'AC 1234 BC'` - тоді екран квитанції (`GET /payments/:id`, finding 13)
     покаже номер, «виїзд до 16:00» і підписаний `operatorQrPayload`; без `paidUntil` QR не
     будується (`operatorQrPayload: null`).

3. **Талон емулятора** (finding 8): нічого сіяти не треба. Емулятор (`PARKING_PROVIDER=emulator`)
   віддає сесію лише за талоном `PC-0418227` (`EMULATOR_TIMELINE.talonCode`, без номера, та сама
   часова лінія 14:00 / 15:20 / 16:00 / 15:52, що й демо-номер). Учасник «знаходить» її через
   `POST /api/v1/parking/sessions/claim { "talonCode": "PC-0418227" }`.

4. **Нічого не видаляти**: нові колонки `parking_sessions.presence_confirmed_at`, `disputed_at`,
   `dispute_reason`, `dispute_comment` і таблиця `parking_webhook_logs` у seed не потрібні.

5. **Backfill** для вже наявних даних - у `docs/pending-sql/parking-payments.sql` (розділ
   «Data backfill»); на чистій базі після seed він нічого не змінює, якщо виконано пункт 2.
