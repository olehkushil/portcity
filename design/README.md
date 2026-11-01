# Дизайн Порт City App — як влаштована тека

| Що | Де | Примітка |
|---|---|---|
| Опублікований прототип (основне посилання) | `PortCity_App_prototype.html` | https://claude.ai/artifact/2pyqr6TwnbcxfdJ6xkYsxN — версія 4 від 30.10.2026: 56 екранів, паркінг перший, чорний стартовий екран |
| Перша версія (довідково) | `v1/PortCity_App_prototype_v1.html`, копія з іншим заголовком `v1/PortCity_App_v1_reference.html` | https://claude.ai/artifact/KhHuCspuXB8wzHcpPepV8m — 29 екранів, звідси взято вигляд чорного блоку паркінгу |
| Джерела другої версії | `v2/shell.html` (каркас: токени, компоненти, іконки, роутер), `v2/fragments/*.html` (екрани по табах), `v2/CONVENTIONS.md` (правила збирачів), `v2/DARK_HERO_SPEC.md` (специфікація чорного блоку паркінгу) | Файл прототипу не редагують вручну, його збирають |
| Збирання і перевірка | `v2/assemble.py` | `python -X utf8 -I v2/assemble.py` збирає `PortCity_App_prototype.html` і перевіряє баланс тегів, ідентифікатори 56 екранів, цілі переходів, іконки, класи, відсутність емодзі |
| Логотипи з сайту | `assets/logo-symbol.svg`, `assets/logo-horizontal.svg`, `assets/logo-stacked.svg` | У каркасі вони вшиті як `<symbol id="logo-s">` і `#logo-h` |
| Рання версія токенів та іконок | `project/pc.css`, `icons.md` | Замінені каркасом v2, лишені для історії |

## Як внести зміну

1. Правити фрагмент у `v2/fragments/` або каркас `v2/shell.html`.
2. Запустити `python -X utf8 -I v2/assemble.py` і дочекатися `OK: no problems found`.
3. Опублікувати `PortCity_App_prototype.html` за тим самим посиланням.

## Локальний перегляд

Файл прототипу не має `<!doctype>` і `<head>` (їх додає платформа артефактів). Для перегляду у браузері обгорнути вміст у документ з `<meta name="viewport" content="width=device-width,initial-scale=1">` і правилом `[hidden]{display:none!important}`, або відкрити опубліковане посилання. На екранах ширше 820 px прототип показується у рамці телефона 390×844 зі списком екранів над нею; на телефоні займає весь екран, список екранів відкривається кнопкою внизу праворуч.
