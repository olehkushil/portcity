# Запити модуля receipts (контракти)

## receipts-1: код `PC_RECEIPT_MANUAL_DISABLED` у `RECEIPT_ERROR_CODES`

- Що потрібно: додати до `RECEIPT_ERROR_CODES` (`src/common/contracts/receipts.ts`) код, який модуль
  уже реєструє в `src/modules/receipts/domain/errors.ts`:

  ```ts
  'PC_RECEIPT_MANUAL_DISABLED', // 403, прапорець receipts.manual_submission вимкнено
  ```

- Для чого: `POST /receipts/manual` (BRIEF розділ 8) з прапорцем `FEATURE_FLAG_KEYS.receiptsManualSubmission`.
- Коли: не блокує; код працює локально.
- Статус: виконано 2026-11-01 (integration).

## receipts-2: значення `processing` у `ReceiptSubmissionOutcome` і поля екрана в `ReceiptSubmissionResult`

- Що потрібно:

  ```ts
  export type ReceiptSubmissionOutcome =
    | 'credited'
    | 'held'
    | 'needs_moderation'
    | 'rejected'
    /** Auto-approved or approved, points are being credited by the receipts-process job. */
    | 'processing';

  export const SUBMISSION_SCREENS = ['credited', 'pending', 'rejected'] as const;

  export interface ReceiptSubmissionResult {
    // ...наявні поля
    screen: (typeof SUBMISSION_SCREENS)[number];
    title: string; // українською
    message: string; // українською
    moderationReasons: string[]; // українською
  }
  ```

- Для чого: відповідь `POST /receipts/qr` і `/receipts/manual` має сказати застосунку, який із трьох
  екранів прототипу показати. Якщо леджер або content недоступні під час подання, чек лишається
  `parsed`/`auto_approved` і дораховується чергою `receipts-process`; зараз модуль повертає для цього
  `outcome = 'needs_moderation'` + `screen = 'pending'`, що семантично неточно. Поля екрана вже є в
  HTTP DTO модуля (`ReceiptSubmissionResultDto`); у контракті `ReceiptSubmissionResult.receipt` має
  тип `ReceiptSummary`, а HTTP-відповідь — `ReceiptDto` без службових полів (`riskFlags`, `userId`).
  Пропоную або вирівняти контракт під DTO, або позначити `ReceiptSubmissionResult` як внутрішній тип.
- Коли: не блокує.
- Статус: виконано 2026-11-01 (integration) у зміненому вигляді: `processing`, `SUBMISSION_SCREENS` і поля екрана в контракті; `ReceiptSubmissionResult` описано як результат сервісу, HTTP DTO віддає безпечну проєкцію `receipt`.

## receipts-3 (до identity): відбиток пристрою для прапорця `device_shared`

- Що потрібно: один із варіантів:
  1. дозволити ребро залежностей receipts -> identity (циклу немає: identity нічого не імпортує) і
     використовувати `IDENTITY_PORT.getDevice(deviceId)` (`DeviceSummary.fingerprint`);
  2. або додати claim `dfp` (sha256 відбитка) в access token учасника.
- Для чого: BRIEF розділ 7, прапорець `device_shared` («той самий пристрій в іншого учасника за 24 год»).
  Зараз модуль рахує його лише за `receipts.device_id`, тому перевстановлення застосунку (новий
  `Device`) обходить перевірку. Читати `devices` через relation Prisma модуль не буде (BRIEF розділ 3).
- Коли: не блокує.
- Статус: відхилено 2026-11-01 (integration), відкладено: `getDevice` повертає fingerprint одного пристрою, а для `device_shared` потрібен пошук пристроїв інших учасників з тим самим fingerprint (новий метод identity або колонка в receipts) - окремий запит після пілота; claim у токені розкрив би відбиток клієнту.

## receipts-4: підтримка запиту content-2 (`recordSeenFiscalNumber(..., { receiptId })`)

- Що потрібно: після прийняття `docs/contract-requests/content.md` (content-2) receipts передаватиме
  `{ receiptId }` у `CONTENT_PORT.recordSeenFiscalNumber(fn, tx, { receiptId })`
  (`src/modules/receipts/services/receipt-pipeline.service.ts`, метод `decide`).
- Для чого: payload `tenant.fiscal_number_seen.receiptId`, щоб модератор бачив джерело нової каси.
- Коли: не блокує; зміна в receipts на один рядок.
- Статус: виконано 2026-11-01 (integration).

English summary: (1) add `PC_RECEIPT_MANUAL_DISABLED` to the contract error list; (2) add a
`processing` outcome and the screen/title/message/moderationReasons fields to the submission result
contract (or mark it internal); (3) device fingerprint access for `device_shared` via an identity port
edge or a token claim; (4) receipts will pass `receiptId` to `recordSeenFiscalNumber` once content-2
is accepted.
