# Frontend handoff: 4 новые опции полей (date-bounds, media-types, regex, private)

Бэкенд для четырёх опций полей готов и в `main` (коммиты `3e026c0`, `89c24e9`, `9972ef2`,
`6adb97e`). Этот документ — всё, что нужно фронтендеру, чтобы (а) дать их в визуальном
Builder'е и (б) правильно отрисовать/подсветить в content-manager'е.

## 0. Где живёт контракт и как Builder читает опции

- **Источник истины контракта** — `packages/sdk/src/types.ts` → `interface FieldOptions`.
  Каждое поле модуля несёт `options: FieldOptions`.
- **Зеркало в админке** — `apps/admin/src/lib/builder-client.ts` → `interface FieldOptions`.
  ⚠️ Сейчас в зеркале НЕТ ключей: `allowedTypes`, `pattern`, `patternFlags`, `patternMessage`,
  `private`. Их надо добавить (min/max/uniqueItems/minItems/maxItems уже есть).
- **Как Builder решает, какие инпуты рисовать** — `apps/admin/src/lib/field-types.tsx`:
  - `optionMetaFor(type): CmsTypeOptionMeta` — набор булевых флагов на тип (какие опции
    применимы). Добавляешь флаг → включаешь инпут для нужных типов.
- **Инлайн-форма настройки поля** — `apps/admin/src/components/builder/field-config.tsx`
  (рисует инпуты, гейтит по `meta.<flag>`).
- **Состояние черновика поля** — `apps/admin/src/lib/module-draft.ts`:
  - `FieldDraft` — строковое редактируемое состояние;
  - `emptyFieldDraft` / `draftFromField` — инициализация (создание / загрузка);
  - `draftOptions(draft)` — сборка `FieldOptions` на отправку;
  - `validateFieldDraft(draft)` — клиентская преваридация (вернёт строку-ошибку или null);
  - `fieldSummary(draft)` — подпись свёрнутой карточки.
- **Метаданные полей для content-manager'а** — приходят из `/builder/modules` как
  `FieldDefinition` (с `options`). То есть `field.options.private`, `.pattern`,
  `.allowedTypes`, `.min`, `.max` доступны на клиенте и должны управлять поведением виджета.

### Как ошибки приходят в content-форму
Любая ошибка записи — HTTP **400** с телом `{ error: { code, message, ... } }` (модуль
error-i18n, локализованный по `Accept-Language`). Для опций полей `code = "body.invalid"`,
`message` — человекочитаемый текст (см. конкретные сообщения ниже). Ошибки СОХРАНЕНИЯ СХЕМЫ
(невалидная опция при Apply в Builder'е) приходят как `TypeOptionError` на шаге Review/Apply.

---

## 1. `date` / `datetime` — границы min/max  ✅ В BUILDER'Е УЖЕ ЕСТЬ

**Контракт:** `min?: string`, `max?: string`. Типы: `date`, `datetime`.

**Значения (строки):**
- абсолютная ISO-8601: `"2026-01-01"` или `"2026-01-01T10:30:00Z"`;
- относительный токен: `"$now"`, `"$now(±N unit)"`, где `unit ∈ second|minute|hour|day|week|month|year`
  (можно множественное число), **знак обязателен**: `"$now(-7 days)"`, `"$now(+1 year)"`.

**Грамматика (та же на клиенте, см. `module-draft.ts`):**
```
NOW:  /^\$now(?:\(\s*[+-]\d+\s+(?:second|minute|hour|day|week|month|year)s?\s*\))?$/
ISO:  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/
```

**Семантика на сервере:** `date` сравнивает по календарному дню в UTC (включительно), `datetime`
— по точному моменту (включительно). Две АБСОЛЮТНЫЕ границы проверяются на `max ≥ min` при
сохранении схемы; относительные — нет.

**Состояние в Builder'е:** флаг `optionMeta.dateBounds` (date/datetime); инпуты «Earliest»/«Latest»
в `field-config.tsx` → `draft.min`/`draft.max`; преваридация `isValidDateBound` в `module-draft.ts`.

**Ошибка записи (400):** `field "X" must be on or after <min>` / `field "X" must be on or before <max>`.

**Подсветка в content-форме:** можно ограничить date-picker min/max. ⚠️ токен `$now(...)` нужно
СНАЧАЛА разрешить в конкретную дату на клиенте (та же грамматика, считаем от `new Date()`), и
только потом скормить пикеру как min/max.

---

## 2. `media` — allowedTypes + диапазон количества  ⚠️ BUILDER UI НАДО ДОБАВИТЬ

**Контракт:** `allowedTypes?: string[]`, `minItems?: number`, `maxItems?: number`. Тип: `media`.

**`allowedTypes` — элементы:**
- категории-бакеты: `"images"` | `"videos"` | `"audios"` | `"files"` (files = всё, что не
  image/video/audio);
- ИЛИ явный MIME: `"image/png"`, или вайлдкард `"image/*"`.
- (неизвестная строка без `/` → ошибка сохранения схемы.)

**Количество (`minItems`/`maxItems`):** имеет смысл ТОЛЬКО для множественного media
(`multiple: true`); на одиночном — ошибка сохранения. Считается по числу РАЗНЫХ id.

**Что добавить в Builder:**
- `field-types.tsx`: флаг (напр. `mediaTypes: boolean`) в `CmsTypeOptionMeta`, выставить
  `true` для `media`;
- `field-config.tsx`: мульти-селект категорий + рядом с уже существующей секцией «Allowed
  count» дать min/max items;
- `module-draft.ts`: добавить в `FieldDraft` поле `allowedTypes: string[]` (а min/max items —
  переиспользовать `minItems`/`maxItems` как в `array`), прокинуть в `draftOptions`/`validate`;
- `builder-client.ts`: добавить `allowedTypes?: string[]` в зеркало `FieldOptions`.

**Ошибка записи (400):**
- неверный тип: `media field "X" does not allow files of type <mime> (id N)` — проверка идёт по
  **сохранённому** MIME ассета (не по тому, что заявил клиент);
- мало/много: `media field "X" needs at least N file(s)` / `accepts at most N file(s)`.

**Подсветка в content-форме:** в media-picker'е можно фильтровать галерею ассетов по
`allowedTypes` и не давать выбрать больше `maxItems` / меньше `minItems`. Сервер — последняя
инстанция (проверяет на реальном MIME), так что клиентский фильтр — это UX, а не гарантия.

---

## 3. `string`/`email`/`uid`/`text` — regex `pattern`  ⚠️ BUILDER UI НАДО ДОБАВИТЬ

**Контракт:** `pattern?: string` (исходник без слешей), `patternFlags?: string`
(подмножество `i m s u`; `g`/`y` запрещены), `patternMessage?: string`. Типы: string, email,
uid, text.

**Семантика:** ПОЛНОЕ совпадение (сервер оборачивает `^(?:...)$`). Движок — RE2 (линейное
время, ReDoS-безопасно). Lookaround/backreferences и флаги `g`/`y` отвергаются при сохранении.

**Что добавить в Builder:**
- `field-types.tsx`: флаг (напр. `pattern: boolean`) для string/email/uid/text;
- `field-config.tsx`: инпут паттерна + инпут флагов + инпут кастомного сообщения;
- `module-draft.ts`: поля в `FieldDraft` (`pattern`, `patternFlags`, `patternMessage`),
  `draftOptions`/`validate`. ⚠️ Клиентский `new RegExp(...)` для преваридации НЕ совпадает 1:1
  с RE2 — для UX достаточно проверить «непустой паттерн» и «флаги только из `imsu`»; сервер
  валидирует строго;
- `builder-client.ts`: добавить три ключа в зеркало `FieldOptions`.

**Ошибка записи (400):** `patternMessage` (если задан) — иначе `field "X" has an invalid format`.
(Плюс защитный кап: если значение длиннее 1 MiB — `field "X" is too long to validate`.)

**Подсветка в content-форме:** можно повесить `pattern=` на `<input>` или своё клиентское
правило и показывать `patternMessage`. Помни про full-match (JS `pattern=` тоже full-match —
совпадает с сервером).

---

## 4. `private` — скрыть из публичного API  ⚠️ BUILDER UI + ⚠️⚠️ ВЛИЯЕТ НА CONTENT-MANAGER

**Контракт:** `private?: boolean`. Применимо к любому top-level полю (внутри компонентов —
запрещено сервером).

**Что добавить в Builder:** тумблер «Private» рядом с Required/Unique в `field-config.tsx`;
`FieldDraft.private` + `draftOptions` в `module-draft.ts`; ключ `private?: boolean` в зеркало
`builder-client.ts`. Гейт по типу не нужен (универсально).

**⚠️⚠️ Поведение в рантайме — это главное для фронта content-manager'а:**
1. **Приватное поле НИКОГДА не приходит в ответах чтения** — ни в list, ни в detail, ни в
   populate связи. В таблице/карточке его значения просто НЕТ.
2. **Писать можно, читать обратно — нельзя.** POST/PUT принимают значение, но GET его не
   вернёт → префилл формы редактирования будет пустым (как поле «пароль»). Рисуй как
   **write-only**: плейсхолдер `•••• (write-only)`, не пытайся показать текущее значение.
3. **Нельзя запрашивать приватное поле через `?fields=`, `filter[...]`, `sort=`** — сервер
   ответит **400**. Значит в content-manager'е:
   - исключи приватные поля из сортируемых колонок;
   - исключи из конструктора фильтров;
   - не клади их в проекцию `fields=`, которую шлёшь на список/деталь.
4. Метаданные поля (`FieldDefinition` из `/builder/modules`) приватное поле всё ещё содержат —
   читай `field.options.private`, чтобы решить: write-only виджет, без сортировки/фильтра.

**Внутри компонентов** `private` не поддержан (сервер отвергает на сохранении схемы) — в
UI можно прятать тумблер для полей компонента (необязательно: всё равно прилетит ошибка).

---

## 5. Рецепт «добавить write-time опцию в Builder» (для #2/#3/#5 — кроме private)

Каждая опция трогает одни и те же 4 файла админки:
1. `field-types.tsx` — флаг в `CmsTypeOptionMeta` + проставить в `optionMeta` для нужных типов.
2. `field-config.tsx` — инпут(ы), гейт `{meta.<flag> && (...)}`.
3. `module-draft.ts` — поле(я) в `FieldDraft`, в `emptyFieldDraft`, `draftFromField` (загрузка),
   `draftOptions` (сборка на отправку), `validateFieldDraft` (преваридация), `fieldSummary`.
4. `builder-client.ts` — синхронизировать `FieldOptions` с SDK.

Готовый пример в коде — секции `numericBounds`, `arrayItems` и `dateBounds` (последняя — это
ровно #2, можно копировать структуру).

## 6. Сводка статуса

| Опция | Backend | Зеркало `builder-client` | Builder UI |
|---|---|---|---|
| #2 date min/max | ✅ | ✅ | ✅ (Earliest/Latest) |
| #5 media allowedTypes + count | ✅ | ❌ allowedTypes | ❌ |
| #1 string pattern | ✅ | ❌ pattern/flags/message | ❌ |
| #4b private | ✅ | ❌ private | ❌ (+ важное влияние на content-manager) |
