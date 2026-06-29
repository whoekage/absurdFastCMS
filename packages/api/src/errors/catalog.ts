import type { Locale } from './render.ts';

/**
 * THE error catalog — the single source of truth for every typed error's HTTP status + its localized
 * message templates. One entry per existing error class (the subclasses now extend {@link AppError}
 * and map their constructor args onto these `{param}` placeholders).
 *
 * BYTE-IDENTICAL CONTRACT: each `messages.en` template, after {@link interpolate} with the SAME params
 * the subclass passes, equals the message that class historically threw — character for character. A
 * few templates therefore expect an ALREADY-transformed param, NOT the raw constructor arg:
 *   - `{value}` / `{name}` / `{file}` on the ddl + schema-(de)serialize codes is `JSON.stringify(arg)`
 *     (the originals did `${JSON.stringify(value)}`), so the surrounding quotes are reproduced exactly.
 *   - `db.ddl.identifier_too_long` `{maxBytes}` is the `MAX_IDENTIFIER_BYTES` constant (63), not a ctor arg.
 *   - `db.migration.blocked` `{count}` = `blocked.length`, `{changeList}` = the pre-joined per-change lines
 *     (`blocked.map((c) => '  - ' + describeChange(c) + ' [' + c.risk + ']').join('\n')`); the raw `blocked`
 *     array also rides in params as a wire extra (see http.ts WIRE_EXTRAS).
 *   - the `db.registry.invalid_field` / `db.schema.adapt` templates carry LITERAL double quotes around
 *     `{name}`/`{field}` exactly as the originals did (raw interpolation, no JSON.stringify).
 *   - every freeform class maps its `message: string` arg to `{ detail: message }`; its `messages` is the
 *     bare string `'{detail}'` — a SHORTHAND meaning "same template in every locale" (no point enumerating
 *     8 identical entries; the detail is server English, promotable to real per-locale codes later).
 *
 * LOCALES (render.ts): en, ru, ky (Kyrgyz), kk (Kazakh), uz (Uzbek-Latin), es (Spanish), ja (Japanese),
 * ko (Korean). `messages` is EITHER a bare string (same in all locales) OR a full `Record<Locale, string>`
 * map — the `satisfies` accepts both. A per-locale map MUST carry every locale (a missing one is a COMPILE
 * error, not a silent runtime `en` fallback). Use the map only when translations actually differ.
 * Placeholders ({value}, {reason}, …) and technical literals (`--allow-destructive`, the relation-kind
 * union) are kept verbatim across every locale. Non-English translations are best-effort — the Central-Asian
 * ones (ky/kk/uz) especially warrant a native review.
 *
 * STATUS = the HTTP status this error maps to at the boundary TODAY. Internal-only errors that currently
 * fall through to a 500 carry status 500 (status parity with builderErrorFields / read+write handlers).
 *
 * `as const satisfies ...` keeps the literal templates (so {@link ErrorCode} is the exact code union) while
 * still type-checking that every entry has a numeric status + a full per-locale message set.
 */
export const CATALOG = {
  // --- db/ddl.ts (identifier + schema-shape guards; all internal -> 500) ----------------------------
  'db.ddl.invalid_identifier': {
    status: 500,
    messages: {
      en: 'invalid identifier {value}: {reason}',
      ru: 'недопустимый идентификатор {value}: {reason}',
      ky: 'жараксыз идентификатор {value}: {reason}',
      kk: 'жарамсыз идентификатор {value}: {reason}',
      uz: 'yaroqsiz identifikator {value}: {reason}',
      es: 'identificador no válido {value}: {reason}',
      ja: '無効な識別子 {value}: {reason}',
      ko: '잘못된 식별자 {value}: {reason}',
    },
  },
  'db.ddl.identifier_too_long': {
    status: 500,
    messages: {
      en: 'identifier {value} is {bytes} bytes; max is {maxBytes}',
      ru: 'идентификатор {value} занимает {bytes} байт(ов); максимум — {maxBytes}',
      ky: 'идентификатор {value} {bytes} байт; максимум {maxBytes}',
      kk: 'идентификатор {value} {bytes} байт; ең көбі {maxBytes}',
      uz: 'identifikator {value} {bytes} bayt; maksimal {maxBytes}',
      es: 'el identificador {value} tiene {bytes} bytes; el máximo es {maxBytes}',
      ja: '識別子 {value} は {bytes} バイトです。最大は {maxBytes} です',
      ko: '식별자 {value}이(가) {bytes}바이트입니다. 최대는 {maxBytes}입니다',
    },
  },
  'db.ddl.reserved_field_name': {
    status: 500,
    messages: {
      en: 'field name {value} is reserved (system column or leading underscore)',
      ru: 'имя поля {value} зарезервировано (системный столбец или ведущее подчёркивание)',
      ky: 'талаа аты {value} брондолгон (системалык тилке же башындагы астын сызуу)',
      kk: 'өріс аты {value} резервтелген (жүйелік баған немесе алдыңғы астын сызу)',
      uz: 'maydon nomi {value} band qilingan (tizim ustuni yoki boshidagi tagchiziq)',
      es: 'el nombre de campo {value} está reservado (columna del sistema o guion bajo inicial)',
      ja: 'フィールド名 {value} は予約されています（システム列または先頭のアンダースコア）',
      ko: '필드 이름 {value}은(는) 예약되어 있습니다 (시스템 열 또는 선행 밑줄)',
    },
  },
  'db.ddl.reserved_table_name': {
    status: 500,
    messages: {
      en: 'module name / table name {value} is reserved',
      ru: 'name модуля / имя таблицы {value} зарезервировано',
      ky: 'модулдун name / таблица аты {value} брондолгон',
      kk: 'модульдің name / кесте аты {value} резервтелген',
      uz: 'modul name / jadval nomi {value} band qilingan',
      es: 'el name del módulo / nombre de tabla {value} está reservado',
      ja: 'モジュールの name / テーブル名 {value} は予約されています',
      ko: '모듈 name / 테이블 이름 {value}은(는) 예약되어 있습니다',
    },
  },
  'db.ddl.duplicate_field': {
    status: 500,
    messages: {
      en: 'duplicate field name {value} (names are unique case-insensitively)',
      ru: 'повторяющееся имя поля {value} (имена уникальны без учёта регистра)',
      ky: 'кайталанган талаа аты {value} (аттар регистрге карабай уникалдуу)',
      kk: 'қайталанатын өріс аты {value} (аттар регистрге тәуелсіз бірегей)',
      uz: 'takrorlanuvchi maydon nomi {value} (nomlar registrdan qatʼiy nazar yagona)',
      es: 'nombre de campo duplicado {value} (los nombres son únicos sin distinguir mayúsculas)',
      ja: 'フィールド名 {value} が重複しています（名前は大文字小文字を区別せず一意です）',
      ko: '중복된 필드 이름 {value} (이름은 대소문자를 구분하지 않고 고유합니다)',
    },
  },
  'db.ddl.module_exists': {
    status: 500,
    messages: {
      en: 'module {name} already exists',
      ru: 'модуль {name} уже существует',
      ky: 'модуль {name} мурунтан эле бар',
      kk: 'модуль {name} бұрыннан бар',
      uz: 'modul {name} allaqachon mavjud',
      es: 'el módulo {name} ya existe',
      ja: 'モジュール {name} は既に存在します',
      ko: '모듈 {name}이(가) 이미 존재합니다',
    },
  },
  'db.ddl.module_not_found': {
    status: 500,
    messages: {
      en: 'module {name} not found',
      ru: 'модуль {name} не найден',
      ky: 'модуль {name} табылган жок',
      kk: 'модуль {name} табылмады',
      uz: 'modul {name} topilmadi',
      es: 'módulo {name} no encontrado',
      ja: 'モジュール {name} が見つかりません',
      ko: '모듈 {name}을(를) 찾을 수 없습니다',
    },
  },
  'db.ddl.field_exists': {
    status: 500,
    messages: {
      en: 'field {value} already exists',
      ru: 'поле {value} уже существует',
      ky: 'талаа {value} мурунтан эле бар',
      kk: 'өріс {value} бұрыннан бар',
      uz: 'maydon {value} allaqachon mavjud',
      es: 'el campo {value} ya existe',
      ja: 'フィールド {value} は既に存在します',
      ko: '필드 {value}이(가) 이미 존재합니다',
    },
  },
  'db.ddl.field_not_found': {
    status: 500,
    messages: {
      en: 'field {value} not found',
      ru: 'поле {value} не найдено',
      ky: 'талаа {value} табылган жок',
      kk: 'өріс {value} табылмады',
      uz: 'maydon {value} topilmadi',
      es: 'campo {value} no encontrado',
      ja: 'フィールド {value} が見つかりません',
      ko: '필드 {value}을(를) 찾을 수 없습니다',
    },
  },
  'db.ddl.default_type': {
    status: 500,
    messages: '{detail}',
  },
  'db.ddl.type_change_forbidden': {
    status: 500,
    messages: '{detail}',
  },
  'db.ddl.type_change_failed': {
    status: 500,
    messages: '{detail}',
  },
  'db.ddl.dependent_types': {
    status: 500,
    messages: '{detail}',
  },
  'db.ddl.duplicate_data': {
    status: 500,
    messages: '{detail}',
  },
  'db.ddl.unknown_relation_kind': {
    status: 500,
    messages: {
      en: 'unknown relation kind {value} (expected oneToOne|oneToMany|manyToOne|manyToMany)',
      ru: 'неизвестный вид связи {value} (ожидается oneToOne|oneToMany|manyToOne|manyToMany)',
      ky: 'белгисиз байланыш түрү {value} (күтүлгөн: oneToOne|oneToMany|manyToOne|manyToMany)',
      kk: 'белгісіз байланыс түрі {value} (күтілгені: oneToOne|oneToMany|manyToOne|manyToMany)',
      uz: 'nomaʼlum bogʻlanish turi {value} (kutilgan: oneToOne|oneToMany|manyToOne|manyToMany)',
      es: 'tipo de relación desconocido {value} (se esperaba oneToOne|oneToMany|manyToOne|manyToMany)',
      ja: '不明なリレーション種別 {value}（想定: oneToOne|oneToMany|manyToOne|manyToMany）',
      ko: '알 수 없는 관계 종류 {value} (예상: oneToOne|oneToMany|manyToOne|manyToMany)',
    },
  },

  // --- db/registry.ts -------------------------------------------------------------------------------
  'db.registry.invalid_field': {
    status: 500,
    messages: {
      en: 'module "{name}" field "{field}": {reason}',
      ru: 'модуль "{name}" поле "{field}": {reason}',
      ky: 'модуль "{name}" талаа "{field}": {reason}',
      kk: 'модуль "{name}" өріс "{field}": {reason}',
      uz: 'modul "{name}" maydon "{field}": {reason}',
      es: 'módulo "{name}" campo "{field}": {reason}',
      ja: 'モジュール "{name}" フィールド "{field}": {reason}',
      ko: '모듈 "{name}" 필드 "{field}": {reason}',
    },
  },

  // --- db/schema/* (load/adapt/codegen/diff/serialize + the migrate engine) -------------------------
  'db.schema.load': {
    status: 500,
    messages: {
      en: 'schema module {file}: {reason}',
      ru: 'модуль схемы {file}: {reason}',
      ky: 'схема модулу {file}: {reason}',
      kk: 'схема модулі {file}: {reason}',
      uz: 'sxema moduli {file}: {reason}',
      es: 'módulo de esquema {file}: {reason}',
      ja: 'スキーマモジュール {file}: {reason}',
      ko: '스키마 모듈 {file}: {reason}',
    },
  },
  'db.schema.adapt': {
    status: 500,
    messages: {
      en: 'module "{name}": {reason}',
      ru: 'модуль "{name}": {reason}',
      ky: 'модуль "{name}": {reason}',
      kk: 'модуль "{name}": {reason}',
      uz: 'modul "{name}": {reason}',
      es: 'módulo "{name}": {reason}',
      ja: 'モジュール "{name}": {reason}',
      ko: '모듈 "{name}": {reason}',
    },
  },
  'db.schema.codegen': {
    status: 500,
    messages: '{detail}',
  },
  'db.schema.diff': {
    status: 422,
    messages: '{detail}',
  },
  'db.schema.file': {
    status: 500,
    messages: {
      en: 'schema file {file}: {reason}',
      ru: 'файл схемы {file}: {reason}',
      ky: 'схема файлы {file}: {reason}',
      kk: 'схема файлы {file}: {reason}',
      uz: 'sxema fayli {file}: {reason}',
      es: 'archivo de esquema {file}: {reason}',
      ja: 'スキーマファイル {file}: {reason}',
      ko: '스키마 파일 {file}: {reason}',
    },
  },
  // SchemaChangeConflictError: the transient schema-lock 409 (Retry-After at the boundary).
  'db.schema.conflict': {
    status: 409,
    messages: '{detail}',
  },
  // SchemaReconcileHaltError: boot-time reconcile halt (internal -> 500).
  'db.schema.reconcile_halt': {
    status: 500,
    messages: '{detail}',
  },
  'db.migration.blocked': {
    status: 409,
    messages: {
      en: 'migration blocked: {count} change(s) require --allow-destructive or are forbidden:\n{changeList}',
      ru: 'миграция заблокирована: {count} изменени(й) требуют --allow-destructive или запрещены:\n{changeList}',
      ky: 'миграция бөгөттөлдү: {count} өзгөртүү --allow-destructive талап кылат же тыюу салынган:\n{changeList}',
      kk: 'көшіру бөгеленді: {count} өзгеріс --allow-destructive талап етеді немесе тыйым салынған:\n{changeList}',
      uz: 'migratsiya bloklandi: {count} oʻzgarish --allow-destructive talab qiladi yoki taqiqlangan:\n{changeList}',
      es: 'migración bloqueada: {count} cambio(s) requieren --allow-destructive o están prohibidos:\n{changeList}',
      ja: 'マイグレーションがブロックされました: {count} 件の変更には --allow-destructive が必要か、禁止されています:\n{changeList}',
      ko: '마이그레이션이 차단되었습니다: {count}개의 변경에 --allow-destructive가 필요하거나 금지되어 있습니다:\n{changeList}',
    },
  },
  'db.migration.unsupported': {
    status: 422,
    messages: '{detail}',
  },
  'db.migration.data_loss': {
    status: 422,
    messages: {
      en: 'migration would lose data: {affected} row(s) in {table}.{column} {detail} — refusing to silently truncate/round (widen the target or clean the rows first)',
      ru: 'миграция приведёт к потере данных: {affected} строк(и) в {table}.{column} {detail} — отказ от молчаливого усечения/округления (расширьте целевой тип или сначала очистите строки)',
      ky: 'миграция маалыматты жоготот: {table}.{column} ичинде {affected} сап {detail} — унчукпай кыскартуу/тегеректөөдөн баш тартуу (максаттуу типти кеңейтиңиз же адегенде саптарды тазалаңыз)',
      kk: 'көшіру деректі жоғалтады: {table}.{column} ішінде {affected} жол {detail} — үнсіз қысқарту/дөңгелектеуден бас тарту (мақсатты типті кеңейтіңіз немесе алдымен жолдарды тазалаңыз)',
      uz: 'migratsiya maʼlumotni yoʻqotadi: {table}.{column} ichida {affected} qator {detail} — jimgina qisqartirish/yaxlitlashdan voz kechilmoqda (maqsadli turni kengaytiring yoki avval qatorlarni tozalang)',
      es: 'la migración perdería datos: {affected} fila(s) en {table}.{column} {detail} — se niega a truncar/redondear silenciosamente (amplíe el tipo de destino o limpie primero las filas)',
      ja: 'マイグレーションによりデータが失われます: {table}.{column} の {affected} 行 {detail} — 暗黙的な切り捨て/丸めを拒否します（対象の型を広げるか、先に行をクリーンアップしてください）',
      ko: '마이그레이션으로 데이터가 손실됩니다: {table}.{column}의 {affected}개 행 {detail} — 자동 잘림/반올림을 거부합니다 (대상 타입을 넓히거나 먼저 행을 정리하세요)',
    },
  },

  // --- request-facing 4xx (the wire-shaped errors) --------------------------------------------------
  'body.invalid': {
    status: 400,
    messages: '{detail}',
  },
  'entry.write': {
    status: 400,
    messages: '{detail}',
  },
  'query.invalid': {
    status: 400,
    messages: '{detail}',
  },
  'cursor.invalid': {
    status: 400,
    messages: {
      en: 'invalid or expired pagination cursor',
      ru: 'недействительный или просроченный курсор постраничной навигации',
      ky: 'жараксыз же мөөнөтү өткөн пагинация курсору',
      kk: 'жарамсыз немесе мерзімі өткен беттеу курсоры',
      uz: 'yaroqsiz yoki muddati oʻtgan sahifalash kursori',
      es: 'cursor de paginación no válido o caducado',
      ja: '無効または期限切れのページネーションカーソル',
      ko: '잘못되었거나 만료된 페이지네이션 커서',
    },
  },
  'hook.failed': {
    status: 400,
    messages: '{detail}',
  },
  'store.keyset_unsupported': {
    status: 500,
    messages: '{detail}',
  },

  // --- compose/builder.ts (the admin Builder routes) -----------------------------------------------
  'builder.validation': {
    status: 422,
    messages: '{detail}',
  },
  'builder.not_found': {
    status: 404,
    messages: '{detail}',
  },
  'builder.busy': {
    status: 500,
    messages: '{detail}',
  },

  // --- storage/provider.ts --------------------------------------------------------------------------
  'storage.object_not_found': {
    status: 500,
    messages: {
      en: 'object not found',
      ru: 'объект не найден',
      ky: 'объект табылган жок',
      kk: 'нысан табылмады',
      uz: 'obyekt topilmadi',
      es: 'objeto no encontrado',
      ja: 'オブジェクトが見つかりません',
      ko: '객체를 찾을 수 없습니다',
    },
  },
} as const satisfies Record<string, { status: number; messages: string | Record<Locale, string> }>;

/** The exact union of every defined error code (drives compile-time exhaustiveness at the call sites). */
export type ErrorCode = keyof typeof CATALOG;
