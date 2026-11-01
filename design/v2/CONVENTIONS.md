# Правила для збирачів екранів прототипу «Порт City App» v2

Прототип — один HTML-файл. Каркас (CSS-токени, компоненти, роутер, таймери, таб-бар) уже написаний у `shell.html`. Ви пишете ЛИШЕ фрагмент із секціями екранів, який буде вставлений на місце `<!-- SCREENS -->`. Зразок стилю й розмітки — опублікована версія 1: `C:\Agent\ПортСіті\design\PortCity_App_prototype.html` (класи там майже ті самі; орієнтуйтесь на неї для структури екранів, але слідуйте токенам і класам із `shell.html`, вони пріоритетні).

Специфікації екранів — у дизайн-брифі `C:\Users\Oleh Kushil\AppData\Local\Temp\claude\C--Users-Oleh-Kushil--claude-spares-spare-zrJAoB\8b670004-2453-4b71-b528-e3f6da5b2138\scratchpad\portcity\design-brief.md` (розділи 2–7). Мікрокопі брифу — канон: не перефразовуйте рядки з розділів 4 і 7.

## Формат фрагмента

- Файл містить тільки блоки `<section class="screen …" id="…" data-tab="…" data-title="…"> … </section>`, без `<html>`, `<head>`, `<style>`, `<script>` і без коментарів поза секціями (коментар-роздільник перед секцією дозволений).
- `id` — лише з переліку, виданого вам у завданні. `data-tab` — ключ таба, який має підсвічуватись: `parking`, `card`, `promos`, `rewards`, `mall`; для онбордингу та повноекранних модалів без таб-бару — порожній рядок `data-tab=""`.
- `data-title` — підпис екрана для списку «Екрани прототипу» (українською, коротко: «Паркінг · безкоштовні 30 хв»).
- Кожна секція: шапка `.top.gut` + контент `.content.gut` (вертикальний стек з gap 12). Для bottom sheet: фон попереднього екрана у `.content` з `aria-hidden="true"` і `style="opacity:.6"`, потім `<button class="dim" type="button" data-go="…" aria-label="Закрити"></button>` і `<div class="sheet" role="dialog" aria-labelledby="…">…</div>`.
- Усі атрибути в подвійних лапках, кожен елемент закритий. Жодних `<img>` із зовнішніми URL, жодних emoji, жодних inline `<style>`/`<script>`.
- Розмір екрана 390×844; контент має поміщатись або скролитись; не робіть елементи ширшими за екран.

## Навігація та поведінка (усе вже працює в каркасі)

- Перехід між екранами: атрибут `data-go="ID"` на `<button type="button">` або `<a>`. Таби перемикає каркас сам за `data-tab`.
- Тост після переходу: `data-toast="Текст"` поруч із `data-go` (або окремо — тоді тост без переходу).
- Копіювання: `data-copy="+380675904546"`.
- Перемикач: `<button class="switch" type="button" role="switch" aria-checked="true" aria-label="…"></button>`.
- Чекбокс: `<label class="check"><i class="on"></i><span>Текст</span></label>` (клік перемикає).
- Степер: `<div class="stepper"><button type="button" data-step="-" aria-label="Менше">−</button><b>2</b><button type="button" data-step="+" aria-label="Більше">+</button></div>`.
- Чипи-фільтри: `<div class="chips"><button class="chip on" type="button">Усі</button>…</div>` (клік перемикає `on` у межах групи). Сегментований контрол: `<div class="seg"><button class="on" type="button" data-go="promos">Акції</button><button type="button" data-go="events">Події</button></div>`.
- Таймери (каркас оновлює щосекунди):
  - `<span class="timer num" data-countdown="1122">18:42</span>` — зворотний відлік m:ss; необов'язково `data-prefix="ще "` / `data-suffix=" хв"`.
  - `<span data-countdown-min="2400" data-prefix="залишилось ">залишилось 40 хв</span>` — відлік у хвилинах.
  - `<span class="num" data-countup="4800">1:20</span>` — прямий відлік h:mm.
  - Кільце: `<div class="ring"><svg viewBox="0 0 120 120" aria-hidden="true"><circle cx="60" cy="60" r="54" fill="none" stroke="var(--line)" stroke-width="6"/><circle cx="60" cy="60" r="54" fill="none" stroke="var(--accent)" stroke-width="6" stroke-linecap="round" data-ring="1122,1800"/></svg><div class="c">…</div></div>`. Зелене кільце — клас `.ring--ok`, червоне — `.ring--bad`; велике 200 px — `.ring.ring--lg` з `viewBox="0 0 200 200"`, `cx="100" cy="100" r="88"`.
  - Кнопка запуску таймера в інформаційному режимі: `<button class="btn btn--primary" type="button" data-start-timer="#id-елемента-з-data-countdown">Запустити таймер</button>`.
- QR-заглушка: `<div class="qr" data-qr="48213907" role="img" aria-label="QR-код учасника"></div>` (розміри: за замовчуванням 160, `.qr--lg` 240, `.qr--sm` 120).

## Компоненти (класи з shell.html)

- Шапка: `<div class="top gut"><svg class="swan" role="img" aria-label="ПортCity"><use href="#logo-s"/></svg><h1>Паркінг</h1><button class="iconbtn iconbtn--box" type="button" aria-label="Картка клубу" data-go="card-qr">[icon i-qr]</button><button class="iconbtn iconbtn--box" type="button" aria-label="Сповіщення" data-go="notifications">[icon i-bell]<span class="dot"></span></button></div>`. На внутрішніх екранах замість лебедя — кнопка «Назад»: `<button class="iconbtn" type="button" aria-label="Назад" data-go="…">[icon i-back]</button>`. На табі «Картка»: дзвіночок і `<button class="avatar" type="button" aria-label="Профіль" data-go="profile">ОК</button>`.
- Іконки: `<svg class="ic" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><use href="#i-NAME"/></svg>`. Доступні NAME: car, p, clock, timer, ticket, qr, scan, receipt, gift, card, wallet, bell, bell-off, user, pin, map, building, cal, tag, percent, chev, back, down, close, check, checkc, xc, alert, info, phone, cam, flash, image, plus, minus, arrow, hist, settings, shield, coffee, film, child, logout, trash, search, grid, star, wifi-off, mail, send, calc, sun, moon, doc, barcode, edit. Маленькі: додайте клас `ic--s` (18) або `ic--xs` (14). Логотипи: `#logo-s` (лебідь, viewBox 39×32), `#logo-h` (горизонтальний «ПортCity», 163×40); колір лебедя — через `color` (`style="color:#fff"` на темному).
- Герой паркінгу: `<div class="hero">` (білий, тінь, радіус 20) або `<div class="hero hero--dark">`; усередині: рядок статусу `.between` (`.pill` + `.plate`), центр (кільце або `.display`), рядок підказки `.body-s.muted`, одна `.btn.btn--primary` із сумою, рядок третинних дій (`.btn.btn--tertiary` у `.row2` або `.hrow`), `<div class="hero__updated">оновлено 15:02</div>`.
- Номерний знак: `<span class="plate"><span class="band" aria-hidden="true"><i></i></span><span class="n">AC 1234 BC</span></span>`; великий `.plate--lg`; поле вводу `<label class="plate plate--input"><span class="band" aria-hidden="true"><i></i></span><input type="text" placeholder="AA 0000 AA" aria-label="Номерний знак" maxlength="10"></label>`.
- Статус: `.pill.pill--ok|--warn|--bad|--info|--neutral|--accent|--ondark` з іконкою `ic--xs` і текстом; статус ніколи лише кольором.
- Кнопки: `.btn.btn--primary` (помаранчева, чорний текст, завжди із сумою, де вона є), `.btn--secondary` (біла з обводкою), `.btn--tertiary` (текст #B85508, 44 px), `.btn--destructive`, `.btn--dark`, `.btn--ondark`, `.btn--ondark-ghost`, `.btn--onaccent` (чорна на помаранчевому екрані), `.btn--sm`. Apple Pay: `<button class="btn btn--dark wallet-pay" type="button" data-go="…">Pay</button>` з іконкою Apple (див. v1). Вимкнена кнопка — `aria-disabled="true"`.
- Картки: `.card` (біла з лінією), `.card--sub` (сіра), `.card--dark`, `.card--soft` (помаранчевий тинт), `.card--flush` (без відступів, для банера зверху); клубна картка `.clubcard` (градієнт) з водяним знаком `<svg class="wm" aria-hidden="true"><use href="#logo-s"/></svg>`.
- Списки: `.card.list` з `style="gap:0;padding:4px 16px"` і рядками `.item` (`.ico`/`.ico--acc`, `.txt` > `.t` + `.s`, праворуч `.v` або шеврон). Рядок «Ваш візит» — `.item.item--72`. Ваучер — `.vcard` (`.logo40`, `.tag`, назва, термін, `.pill`).
- Банери: `.banner.banner--warn|--bad|--info|--ok|--gray` з іконкою; офлайн-смуга `.banner.banner--offline` («Офлайн. Показуємо дані на 15:02»). Одночасно не більше одного системного банера на екрані.
- Поля: `.field` > `label` + `.input`; `.input--area` для textarea; помилка `.input--error` + `.err`; підказка `.hint`; код із SMS — `.otp` з шістьма `span`.
- Ключ-значення: `.kv` (`<span>`, `<b>`); небезпечний рядок — `.kv.kv--bad`.
- Сітка винагород: `.grid2` > `.tile` (`.media` 4:3, `.t`, `.p`, `.pill`).
- Порожній стан: `.empty` з лебедем `<svg aria-hidden="true"><use href="#logo-s"/></svg>`, рядком тексту й однією кнопкою.
- Помаранчевий екран активації: `<section class="screen screen--accent activation" …>` з чорним текстом, `.display` кодом, таймером `data-countdown="119"`, смугою `<div class="activation__stripe" aria-hidden="true"></div>` і кнопкою `.btn--onaccent`.
- Типографіка: `.display` 40/44, `.h1` 28/34, `.h2` 22/28, `.h3` 17/22, `.body`, `.body-s`, `.caption`, `.eyebrow`; кольори тексту `.muted`, `.ink`, `.accent-text`, `.ok-text`, `.bad-text`. Помаранчевий текст на білому — ТІЛЬКИ клас `.accent-text`.

## Дані прикладу (єдина хронологія для всіх екранів)

Авто AC 1234 BC, підземний контур. В'їзд 14:00; безкоштовно до 14:30; 14:31–15:00 — 20 ₴; 15:00–16:00 — 40 ₴. Стан «безкоштовно» показуємо о 14:11 (ще 18:42). Стан «до сплати» показуємо о 15:20: 60 ₴, «Наступна година почнеться о 16:00 (+40 ₴)», оновлено 15:20. Оплата 60 ₴ о 15:20, номер платежу 4F7K-2031, виїзд до 16:00 (залишилось 40 хв). Прострочено: 16:00 минуло, доплата 40 ₴. Закрито: виїзд 15:52, «1 год 52 хв · 60 ₴». Користувачка Олена К., телефон +380 67 ••• 45 46, баланс «Доступно 240 · Очікують 65», ID картки 7 342 118. Чек: ARBER, 4 000 ₴ → «+120 балів»; чек на перевірці: Comfy 12 990 ₴ («Сума понад 1 000 ₴»); відхилений: ТамТам («каса не бере участі в програмі»). Ваучери: «Кава з собою» (Aroma Kava, 60 балів), код активації 7K4P, таймер 1:59. Купон −20 % INTERTOP до 15.11. Подія: майстер-клас «Розпис пряників», Сб 1 листопада 12:00, Figli Migli 3 поверх, вільно 12 місць. Оператор паркінгу: +38 (067) 590-45-46. Графік: підземний 8:00–21:00, наземний 05:00–00:00, ТРЦ 10:00–22:00. Тарифи: 0–30 хв безкоштовно; 31–60 хв 20 ₴; далі 40 ₴/год; 00:00–05:00 — 500 ₴/год; втрата талона 500 ₴.

## Якість

- Кожна кнопка кудись веде (`data-go` на існуючий id з переліку всіх екранів нижче) або показує тост.
- Цілі тапу ≥ 44 px, контраст тексту ≥ 4,5:1 (не кладіть помаранчевий текст на білий, крім `.accent-text`).
- Кожен екран має `<h1>` у шапці (крім сплешу й модалів, де заголовок усередині).
- Не вигадуйте нових кольорів і класів; якщо чогось бракує, зробіть це інлайн-стилем через токени `var(--…)`.

## Усі id екранів прототипу

Онбординг: splash, welcome, onb-car, notif-permission.
Паркінг повний режим: parking-nocar (F0), parking-idle (F1), parking-free (F2), parking (F3, стартовий), parking-pay (S04), parking-pay-fail, parking-paid (F4), parking-receipt (S05), parking-overstay (F5), parking-closed (F6), parking-still (F7).
Паркінг інформаційний режим: parking-info0 (I0), parking-info1 (I1), parking-info2 (I2), parking-info3 (I3), parking-info4 (I4).
Паркінг сервіс: parking-service (S06), add-car, parking-talon, where (S07), parking-alert (приклад екрана з банером тривоги у відкритій сесії).
Картка і чеки: card (S09), card-qr, card-guest, login, login-code, login-name (S08), scan, scan-manual, scan-result, scan-pending, scan-rejected (S10), history, history-parking (S11).
Акції та події: promos, promo, promo-confirm (S14), events, event, ticket (S15).
Винагороди: rewards, reward, reward-confirm (S12), vouchers, voucher, activation, activation-done (S13).
ТРЦ та інше: mall, store (S16), notifications (S17), profile (S18), support.
