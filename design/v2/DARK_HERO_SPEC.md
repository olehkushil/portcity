# Dark parking hero — restyle spec (v2 fragments, parking tab)

Owner of this spec: lead. Builders edit ONLY the fragment file they are assigned. `shell.html` is read-only for builders (the lead already added the CSS listed under "Shell support").

## Why

The client chose the look of prototype v1: the first page of the app is the Parking tab with a **black hero card** on the light page, the **horizontal logo** in the header, big numbers, an orange progress bar and two dark-grey ghost buttons under the primary button. Reference: `design/v1/PortCity_App_prototype_v1.html`, screen `#parking` (the `card card--dark` block) and `#parking-free`, `#parking-nocar`, `#parking-info`.

v2 (`design/v2/fragments/screens-parking-full.html`, `screens-parking-info.html`) has the right flows and copy but a white hero. Keep v2's flows, ids, copy canon and data attributes; change the visual structure of every parking hero to the v1 look.

## Scope

Screens whose `.hero` must become `hero hero--dark` (all have `data-tab="parking"`):

- `screens-parking-full.html`: `parking-nocar` (F0), `parking-idle` (F1), `parking-free` (F2), `parking` (F3, the start screen), `parking-pay` (S04 sheet over F3), `parking-pay-fail`, `parking-paid` (F4), `parking-overstay` (F5), `parking-closed` (F6), `parking-still` (F7).
- `screens-parking-info.html`: `parking-info0`, `parking-info1`, `parking-info2`, `parking-info3`, `parking-info4`, `parking-alert`.

Screens without a hero (`parking-service`, `add-car`, `parking-talon`, `where`) keep their layout. Only the header rule below applies to them if they currently show the swan + "Паркінг" title (sub-screens with a back button and their own title keep back + title).

## Header rule (top-level parking screens)

Replace

```html
<svg class="swan" role="img" aria-label="ПортCity"><use href="#logo-s"/></svg>
<h1>Паркінг</h1>
```

with

```html
<svg class="logo" role="img" aria-label="ПортCity"><use href="#logo-h"/></svg>
<span class="grow"></span>
```

Keep the two icon buttons (QR → `card-qr`, bell → `notifications`) exactly as they are. `.logo` is 120×30, defined in the shell.

## Hero structure (the v1 look), in this order inside `<div class="hero hero--dark">`

1. **Status row** — `<div class="between">`: a status pill `pill pill--ondark` with a leading dot `<span class="d"></span>` (dot is orange by default; for free time use `style="background:var(--ok)"` on the dot, for idle/closed `style="background:var(--on-dark-muted)"`, for alert/overstay `style="background:var(--bad)"`), then the plate `<span class="plate">…</span>` (white border comes automatically inside `hero--dark`). F0 has no plate: put the pill alone.
2. **Figures row** — `<div class="between" style="align-items:flex-end">`: left `<div><div class="eyebrow">LABEL</div><div class="display num">VALUE</div></div>`; right (optional) `<div style="text-align:right"><div class="eyebrow">LABEL</div><div class="h3 num">VALUE</div></div>`. Keep v2's timer attributes (`data-countdown`, `data-countdown-min`, `data-countup`) on the value elements; do not use `data-ring` inside the dark hero (remove the ring markup if v2 has one in these screens and show the same value as text).
3. **Progress bar** — `<div class="bar" aria-hidden="true"><i style="width:NN%"></i></div>`. F2: share of the free 30 minutes elapsed; F3, F5: share of the current paid hour elapsed; F4: share of the paid hour elapsed; info1–info3 analogous. Omit for F0, F1, F6, F7, info0, info4, alert.
4. **Caption** — `<div class="caption muted">` one or two sentences, at most 120 characters, canon copy. Example F3: `Безкоштовні 30 хв минули о 14:42. Поточна година до 16:00 — 40 ₴, далі 40 ₴ за годину.`
5. **Primary action** — keep v2's primary button (`btn btn--primary`, orange). If v2 has no primary action in that state, keep it that way.
6. **Ghost row** — `<div class="row2">` with two `btn btn--ondark-ghost btn--sm` buttons, each with a 20px icon then text:
   - default pair for F2–F5: `#i-pin` "Рівень −1 · B" → `data-go="where"` and `#i-info` "Тарифи" → `data-go="parking-service"`;
   - where v2 already has two secondary actions with other targets in that state (for example F3 "Я вже виїхав", F6 "Сканувати чек", F7 "Я виїхав"), keep v2's targets and labels and only restyle them to `btn btn--ondark-ghost btn--sm`; any third action goes under the row as a full-width `btn btn--tertiary` (the shell makes it orange on the dark hero).
   Icon markup: `<svg class="ic" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><use href="#i-pin"/></svg>`.
7. **Updated line** — keep `<div class="hero__updated">оновлено HH:MM</div>`.

Order on the page: hero first, then the warn banner ("Підземний паркінг зачиняється о 21:00"), then the rest of v2's content (the "Ваш візит" list stays, at most three items). Move the banner below the hero where v2 has it above.

## State-specific notes

- **F0 `parking-nocar`**: pill "Авто не додано" (muted dot), eyebrow `ПЕРШІ 30 ХВИЛИН`, display `Безкоштовно`, caption with the tariff in one line, primary "Додати номер авто" → `add-car` (keep v2's target), ghost row: `#i-ticket` "У мене талон" → `parking-talon`, `#i-info` "Тарифи" → `parking-service`.
- **F1 `parking-idle`**: pill "Сесії немає" (muted dot) + plate; display shows v2's content (for example `Не на паркінгу`); no bar.
- **F2 `parking-free`**: pill "Безкоштовно до 14:42" (green dot) + plate; left `ЗАЛИШИЛОСЬ` + countdown; right `НА ПАРКІНГУ З` + `14:12`; bar.
- **F3 `parking`** (start screen): pill "На паркінгу з 14:12" (orange dot) + plate; left `ДО СПЛАТИ ЗАРАЗ` + `60 ₴`; right `ТРИВАЛІСТЬ` + countup `1:08`; bar 33 %; caption as above; primary "Оплатити 60 ₴" → `parking-pay`; ghost row "Рівень −1 · B" → `where`, "Я вже виїхав" → keep v2's target; add "Тарифи" → `parking-service` as the third action only if it does not push the hero below the fold at 390×844 (prefer not to).
- **S04 `parking-pay`, `parking-pay-fail`**: the hero behind the sheet is the F3 dark hero (same markup; dim it with `style="opacity:.6"` only if v2 dims the background).
- **F4 `parking-paid`**: pill "Оплачено" (green dot) + plate; left `ВИЇЗД ДО` + `16:00`; right `ЗАЛИШИЛОСЬ` + countdown-min; bar; caption "Після 16:00 почнеться нова година — 40 ₴. Шлагбаум відкриється за номером."; keep v2's receipt action.
- **F5 `parking-overstay`**: pill "Прострочено з 16:00" (red dot) + plate; left `ДОПЛАТА` + `40 ₴`; right `ПРОСТРОЧЕНО НА` + value; bar 100 %; primary "Доплатити 40 ₴".
- **F6 `parking-closed`**: pill "Візит завершено 15:52" (muted dot) + plate; left `ТРИВАЛІСТЬ` + `1:52`; right `СПЛАЧЕНО` + `60 ₴`; no bar; keep v2's bridge to receipt scanning.
- **F7 `parking-still`**: pill "Ви ще на паркінгу?" (orange dot) + plate; display = elapsed; primary "Так, я тут"; ghost "Я виїхав" (keep v2 targets).
- **info0** (setup form): the dark hero holds only the pill "Інфо-режим", the eyebrow + display (`30 хв` / `Безкоштовно`), the caption and the primary "Я щойно заїхав" (keep v2's `data-start-timer` / targets). Form controls (`.seg`, `.chips`, steppers, inputs) must NOT sit inside the dark hero: move them into a light `.card` directly under the hero, keeping their ids and behaviours.
- **info1–info4**: same mapping as F2, F3, F4, F6.
- **parking-alert**: pill "Повітряна тривога" (red dot); keep v2's copy and actions.

## Hard rules

- Do not edit `shell.html`, `assemble.py`, `CONVENTIONS.md` or the other fragment. Do not add new `<symbol>`s; use only existing icons (`i-pin`, `i-info`, `i-ticket`, `i-clock`, `i-timer`, `i-car`, `i-receipt`, `i-scan`, `i-qr`, `i-alert`, `i-check`, `i-arrow`, `i-chev` and the rest listed in CONVENTIONS.md).
- Keep every `id`, `data-go`, `data-tab-go`, `data-start-timer`, `data-countdown*`, `data-countup`, `data-toast`, `data-copy` that v2 has in the screen (you may add new `data-go` to existing ids, never remove one). Keep screen `data-title`s.
- No emoji, no external images, no inline `<style>` or `<script>`. Inline `style=""` only for the small things shown here (dot colour, bar width, opacity, text-align, align-items).
- Classes must exist in the shell (assemble.py checks). Useful on dark: `pill--ondark`, `btn--ondark`, `btn--ondark-ghost`, `btn--tertiary`, `eyebrow`, `display`, `h3`, `num`, `caption`, `muted`, `bar`, `row2`, `between`, `stack`, `grow`, `plate`, `hero__updated`.
- Validate after editing: `python -X utf8 -I "C:/Agent/ПортСіті/design/v2/assemble.py" --out "<your scratch path>/check.html"` must end with `OK: no problems found`. If the only problems reported are in the other builder's fragment, ignore them and say so in your report.
- Report at the end (plain text): the screens you changed, anything from this spec you could not apply and why, and the exact assemble.py output tail.

## Shell support already in place

`.logo`, `.pill .d`, `.pill--ondark .d` (orange), `.hero--dark` ring in the dark theme, `.hero--dark .btn--tertiary` orange, `.hero--dark .caption/.body-s` muted-on-dark, `.hero--dark .bar` dark track, `.hero--dark .plate` white border.
