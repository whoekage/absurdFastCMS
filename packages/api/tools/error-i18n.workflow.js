export const meta = {
  name: 'error-i18n-module',
  description: 'Build src/errors/ (AppError + catalog + render + locale + boundary), re-parent all api error classes onto AppError byte-identically (throw sites untouched), rewire the HTTP error boundary to one toErrorResponse + Accept-Language, add a code field to the SDK error tower, and adversarially verify byte-identical messages + status parity.',
  phases: [
    { title: 'Survey', detail: 'inventory every error class/message/param/status, parallel by subsystem' },
    { title: 'Foundation', detail: 'design + WRITE src/errors/* + catalog (max effort)' },
    { title: 'Convert', detail: 're-parent each error file onto AppError, parallel by file' },
    { title: 'Boundary+SDK', detail: 'single toErrorResponse + Accept-Language; SDK code field' },
    { title: 'Verify', detail: 'adversarial: byte-identical en, status parity, no leak' },
  ],
}

const ROOT = 'packages/api'

const CONTRACT = [
  'src/errors/ DESIGN CONTRACT (decisions locked: D1 additive wire, D2 bespoke {param} interpolator with NO i18n lib,',
  'D3 inline-TS catalog with a typed ErrorCode, D4 THIN subclasses over AppError, D5 Accept-Language, D6 api-only now).',
  '',
  'FILES (all under ' + ROOT + '/src/errors/, native TS, explicit .ts import paths, no build):',
  '- catalog.ts: export const CATALOG = { "<code>": { status: <number>, messages: { en: "<tpl>", ru: "<tpl>" } }, ... } as const',
  '    satisfies Record<string, { status: number; messages: Record<Locale, string> }>; export type ErrorCode = keyof typeof CATALOG.',
  '- render.ts: export const LOCALES = ["en","ru"] as const; export type Locale = (typeof LOCALES)[number];',
  '    export function interpolate(tpl: string, params: Record<string, unknown>): string  // replace {name} with String(params[name]); leave an unknown {x} as-is.',
  '    export function render(code: string, params: Record<string, unknown>, locale: Locale): string  // pick CATALOG[code].messages[locale] ?? messages.en ?? code, then interpolate.',
  '- app-error.ts: export class AppError extends Error { constructor(public readonly code: string, public readonly params: Record<string, unknown> = {}, options?: { cause?: unknown }) { super(render(code, params, "en"), options); this.name = "AppError"; } get status(): number { return CATALOG[this.code as ErrorCode]?.status ?? 500; } }',
  '    The super() text is the DEFAULT-locale render, used for logs/stack only; the WIRE message is re-rendered per request at the boundary.',
  '- locale.ts: export function localeFromAcceptLanguage(header: string | undefined): Locale  // first supported tag, fallback "en".',
  '- http.ts: export function toErrorResponse(e: unknown, locale: Locale): { status: number; body: Record<string, unknown>; headers?: Record<string, string> }.',
  '    If e instanceof AppError: body = { error: render(e.code, e.params, locale), code: e.code }; then copy WHITELISTED structured extras from',
  '    e.params onto body for the codes that need them (migration-data-loss: table/column/affected; migration-blocked: the blocked array);',
  '    set headers { "Retry-After": "1" } for the schema-lock-conflict code. Otherwise return { status: 500, body: { error: "internal error",',
  '    code: "internal" } } and NEVER leak an arbitrary message. The api builder routes wrap errors in an { ok:false, error, ...extras } envelope',
  '    elsewhere; expose enough from toErrorResponse for that caller to keep its envelope byte-identical. Document precisely what you expose.',
  '- index.ts: barrel re-exporting AppError, CATALOG, ErrorCode, Locale, LOCALES, render, interpolate, toErrorResponse, localeFromAcceptLanguage.',
  '',
  'HARD CONSTRAINTS:',
  '- BYTE-IDENTICAL: each catalog en template, after interpolate() with the same params, MUST equal the message the class CURRENTLY throws,',
  '  character for character (tests assert exact messages and statuses). Derive every {param} placeholder from the current super(...) template.',
  '- THROW SITES ARE FROZEN: do NOT change any "throw new XxxError(...)" call anywhere. Each subclass KEEPS its current constructor signature',
  '  and maps internally to super("<code>", { ...named params... }). Keep every extra public field handlers read (RegistryError.apiId/field,',
  '  MigrationDataLossError.table/column/affected, MigrationBlockedError.blocked, the schema-lock conflict semantics, etc.).',
  '- STATUS PARITY: the catalog status for each code MUST equal the HTTP status that error maps to today at the boundary. Internal-only errors',
  '  that currently fall through to 500 get status 500.',
  '- CODES: stable, lowercase, dotted/namespaced, e.g. db.registry.invalid_field, query.invalid, body.invalid, builder.validation,',
  '  db.migration.blocked, db.schema.conflict, store.keyset_unsupported, cursor.invalid, storage.object_not_found.',
  '- FREEFORM passthrough: classes that take a free message:string (QueryParseError, BodyParseError, EntryWriteError, HookError, etc.) KEEP that',
  '  signature and map to a code whose en template is exactly {detail} with params { detail: message } (byte-identical; promotable to real codes',
  '  later). Mark these freeform:true.',
].join('\n')

// ----------------------------------------------------------------------------------------------- SURVEY
phase('Survey')
const SURVEY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['classes'],
  properties: {
    classes: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      required: ['className', 'file', 'currentStatus', 'enTemplate', 'params', 'constructorSig', 'throwSites', 'freeform', 'extraPublicFields'],
      properties: {
        className: { type: 'string' },
        file: { type: 'string', description: 'path relative to repo root' },
        currentStatus: { type: 'number', description: 'HTTP status it maps to at the boundary today; 500 if internal/never-leaked' },
        enTemplate: { type: 'string', description: 'the CURRENT thrown message with {param} placeholders in place of interpolated values; byte-identical literal text' },
        params: { type: 'array', items: { type: 'string' }, description: 'placeholder names used in enTemplate' },
        constructorSig: { type: 'string', description: 'the current constructor parameter list, verbatim' },
        throwSites: { type: 'number' },
        freeform: { type: 'boolean', description: 'true if it takes a free message:string baked verbatim (en template is just {detail})' },
        extraPublicFields: { type: 'array', items: { type: 'string' }, description: 'public fields handlers read besides message (apiId, blocked, table, ...)' },
      },
    } },
  },
}
const surveyUnits = [
  { label: 'db/ddl', files: ROOT + '/src/db/ddl.ts' },
  { label: 'db/core', files: ROOT + '/src/db/registry.ts, ' + ROOT + '/src/db/body.parser.ts, ' + ROOT + '/src/db/entry.repository.ts' },
  { label: 'db/schema', files: ROOT + '/src/db/schema/{migrate,load,adapt,codegen,diff,hooks,serialize}.ts' },
  { label: 'store', files: ROOT + '/src/store/{table,query.parser,cursor.codec}.ts' },
  { label: 'compose+storage', files: ROOT + '/src/compose/{builder,boot-reconcile}.ts, ' + ROOT + '/src/storage/provider.ts' },
]
const surveys = (await parallel(surveyUnits.map((u) => () =>
  agent(
    'You are surveying error classes in the @conti/api workspace for an i18n error-module migration. Read these file(s): ' + u.files + '\n\n' +
    'For EVERY class that extends Error defined there, return one entry. Read the constructor and the EXACT string passed to super(...). Produce enTemplate by replacing the interpolated expressions inside the template literal with {paramName} placeholders (clear names; keep ALL literal text — quotes, punctuation, spacing — byte-identical). ' +
    'Determine currentStatus by checking how the boundary maps this error today: grep ' + ROOT + '/src/http/read.router.ts, write.handler.ts, uws.adapter.ts for "instanceof <ClassName>" and read the status returned; if never matched there (internal), use 500. ' +
    'Count throw sites: grep -rc "throw new <ClassName>" ' + ROOT + '/src. List extraPublicFields = readonly/public fields the class exposes that the boundary or callers read besides message. Mark freeform:true when the constructor takes a free message:string baked verbatim. Be exhaustive and precise — this drives a byte-identical migration.',
    { label: 'survey:' + u.label, phase: 'Survey', schema: SURVEY_SCHEMA, effort: 'high' },
  ),
))).filter(Boolean)
const inventory = surveys.flatMap((s) => s.classes)
log('surveyed ' + inventory.length + ' error classes across ' + surveyUnits.length + ' subsystems')

// ----------------------------------------------------------------------------------------------- FOUNDATION
phase('Foundation')
const DESIGN_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['codes', 'filesWritten', 'boundaryNotes', 'specialCases'],
  properties: {
    codes: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      required: ['code', 'className', 'file', 'status', 'paramsOrder', 'en', 'ru', 'freeform', 'extraWireFields'],
      properties: {
        code: { type: 'string' }, className: { type: 'string' }, file: { type: 'string' }, status: { type: 'number' },
        paramsOrder: { type: 'array', items: { type: 'string' }, description: 'constructor arg names in order, mapped to params keys' },
        en: { type: 'string' }, ru: { type: 'string' }, freeform: { type: 'boolean' },
        extraWireFields: { type: 'array', items: { type: 'string' }, description: 'structured params the boundary copies onto the wire body (blocked, table, column, affected)' },
      },
    } },
    filesWritten: { type: 'array', items: { type: 'string' } },
    boundaryNotes: { type: 'string', description: 'exactly how toErrorResponse handles extra wire fields + Retry-After + the builder ok:false envelope' },
    specialCases: { type: 'string', description: 'any class that could not be made byte-identical, with the reason' },
  },
}
const design = await agent(
  'You are the lead engineer building the src/errors/ module for @conti/api. Implement the CONTRACT EXACTLY, then WRITE the files into ' + ROOT + '/src/errors/.\n\n' +
  CONTRACT + '\n\n' +
  'Surveyed inventory of every existing error class:\n' + JSON.stringify(inventory, null, 2) + '\n\n' +
  'TASKS (think hard — this is the architectural core):\n' +
  '1) Assign each class a stable namespaced code. Build CATALOG with status (= currentStatus) and messages.en (= enTemplate, BYTE-IDENTICAL) plus a faithful messages.ru translation. Freeform classes use en {detail}. Prefer one code per class.\n' +
  '2) WRITE all six files (catalog.ts, render.ts, app-error.ts, locale.ts, http.ts, index.ts) per the contract. toErrorResponse must copy extraWireFields from params onto the body for the codes that need them and set Retry-After for the schema-lock conflict code; never leak a non-AppError message (-> 500 internal error).\n' +
  '3) Run: cd ' + ROOT + ' && npx tsc -p tsconfig.json --noEmit 2>&1 | head -40  — and make sure YOUR new src/errors/ files type-check (pre-existing errors elsewhere are fine).\n' +
  '4) Return the full code map (codes[]) so Convert can re-parent each class deterministically, plus boundaryNotes (how the wire is shaped) and any specialCases. Every surveyed class MUST appear in codes[].',
  { label: 'design+write-foundation', phase: 'Foundation', schema: DESIGN_SCHEMA, effort: 'max' },
)
log('foundation written: ' + (design && design.filesWritten ? design.filesWritten.join(', ') : '(none)') + ' — ' + (design && design.codes ? design.codes.length : 0) + ' codes')

// ----------------------------------------------------------------------------------------------- CONVERT
phase('Convert')
const convertFiles = [
  [ROOT + '/src/db/ddl.ts'],
  [ROOT + '/src/db/registry.ts'],
  [ROOT + '/src/db/body.parser.ts'],
  [ROOT + '/src/db/entry.repository.ts'],
  [ROOT + '/src/db/schema/migrate.ts'],
  [ROOT + '/src/db/schema/load.ts', ROOT + '/src/db/schema/adapt.ts', ROOT + '/src/db/schema/codegen.ts', ROOT + '/src/db/schema/diff.ts', ROOT + '/src/db/schema/hooks.ts', ROOT + '/src/db/schema/serialize.ts'],
  [ROOT + '/src/store/table.ts'],
  [ROOT + '/src/store/query.parser.ts'],
  [ROOT + '/src/store/cursor.codec.ts'],
  [ROOT + '/src/compose/builder.ts'],
  [ROOT + '/src/compose/boot-reconcile.ts'],
  [ROOT + '/src/storage/provider.ts'],
]
const codeMapJson = JSON.stringify(design && design.codes ? design.codes : [])
const conv = await parallel(convertFiles.map((fileList) => () =>
  agent(
    'Re-parent the error class(es) in this/these file(s) onto the new AppError, BYTE-IDENTICALLY. Files: ' + fileList.join(', ') + '\n\n' +
    CONTRACT + '\n\n' +
    'The foundation module already exists at ' + ROOT + '/src/errors/ — import AppError from the correct RELATIVE path (verify the depth, e.g. ../errors/app-error.ts or ../../errors/app-error.ts).\n' +
    'Code map (apply only the entries whose file matches yours):\n' + codeMapJson + '\n\n' +
    'For EACH error class defined in your file(s): change "extends Error" to "extends AppError"; replace the super(...) message call with super("<code>", { <named params built from the constructor args> }); KEEP the constructor SIGNATURE identical; let AppError set name (drop a redundant this.name = ... if the code map allows); KEEP every extra public field assignment (apiId, field, table, blocked, ...). Do NOT touch any "throw new" site. Do NOT change exported names or types. Remove a now-unused private message-formatting helper only if it is truly unused.\n' +
    'After editing, run: grep -nE "extends (Error|AppError)" ' + fileList.join(' ') + '  — to confirm the re-parent; and cd ' + ROOT + ' && npx tsc -p tsconfig.json --noEmit 2>&1 | head -60  — and confirm your files gained no NEW type errors. Return a short summary of what changed and any deviation from byte-identical.',
    { label: 'convert:' + fileList[0].split('/').slice(-1)[0], phase: 'Convert', effort: 'high' },
  )
))
log('converted ' + conv.filter(Boolean).length + '/' + convertFiles.length + ' error files')

// ----------------------------------------------------------------------------------------------- BOUNDARY + SDK
phase('Boundary+SDK')
const boundaryNotes = design && design.boundaryNotes ? design.boundaryNotes : ''
const wire = await parallel([
  () => agent(
    'Rewire the HTTP error boundary in ' + ROOT + '/src/http/read.router.ts and ' + ROOT + '/src/http/write.handler.ts to use the single helper toErrorResponse from ' + ROOT + '/src/errors/ (verify the relative import path).\n\n' +
    'Every place that currently does "if (e instanceof QueryParseError) return errorResponse(400, e.message)" (and the sibling instanceof checks for BodyParseError/EntryWriteError/HookError/InvalidCursorError) should instead resolve a Locale and call toErrorResponse(e, locale), then map its { status, body } onto the existing errorResponse(...) shape — preserving the CURRENT wire shape but now also carrying the additive code field. If these routers cannot reach the request Accept-Language header, fall back to locale "en" and leave a TODO comment pointing at where Accept-Language should thread through; do NOT invent header plumbing that breaks types. Keep behaviour byte-identical (same status, same error string). Boundary contract from the design: ' + boundaryNotes + '\n' +
    'Run: cd ' + ROOT + ' && npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E "read.router|write.handler" | head  — and return what changed.',
    { label: 'wire:read+write', phase: 'Boundary+SDK', effort: 'high' },
  ),
  () => agent(
    'Rewire the Builder error boundary in ' + ROOT + '/src/http/uws.adapter.ts. Find builderError(e) near line 179 — the function with the instanceof chain over BuilderNotFoundError/BuilderValidationError/SchemaDiffError/MigrationBlockedError/MigrationDataLossError/MigrationUnsupportedError/SchemaChangeConflictError returning { status, fields }. Replace its body with a call to toErrorResponse from ' + ROOT + '/src/errors/ (verify the relative import), mapping the result onto the EXISTING builder envelope { ok:false, error, ...extras } and preserving Retry-After for the schema-lock conflict. Use localeFromAcceptLanguage if the request header is reachable here, else "en" with a TODO. Keep responses BYTE-IDENTICAL (same status, same error text, same extras blocked/table/column/affected, same Retry-After). Boundary contract: ' + boundaryNotes + '\n' +
    'Run: cd ' + ROOT + ' && npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E "uws.adapter" | head  — and return what changed; confirm byte-identical envelopes.',
    { label: 'wire:builderError', phase: 'Boundary+SDK', effort: 'high' },
  ),
  () => agent(
    'Add the additive error code to the @conti/sdk typed error tower (packages/sdk/src/client.ts), so SDK consumers branch on a STABLE code instead of parsing English.\n' +
    'ADDITIVE changes only (do not break the existing shape): (1) add "readonly code?: string" to class ApiError and set it from a new optional last constructor param; (2) update errorFromResponse(status, message, body) to read a string code off the parsed body (body && body.code) and pass it into the constructed ApiError subclass; (3) ensure the request pipeline that calls errorFromResponse (near line 513/527) passes the parsed body so code is captured. Keep ApiError(status, message, body) back-compatible (code optional). messageFromBody stays. Do not change test behaviour.\n' +
    'Run: cd packages/sdk && npx tsc -p tsconfig.json --noEmit 2>&1 | head  — (pre-existing loose-typing errors in tests are fine; src must be clean). Return what changed.',
    { label: 'wire:sdk-code', phase: 'Boundary+SDK', effort: 'high' },
  ),
])

// ----------------------------------------------------------------------------------------------- VERIFY
phase('Verify')
const VERDICT = {
  type: 'object', additionalProperties: false, required: ['ok', 'findings'],
  properties: {
    ok: { type: 'boolean', description: 'true if this dimension is fully byte-identical / correct' },
    findings: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['severity', 'where', 'detail'],
      properties: { severity: { type: 'string', enum: ['blocker', 'warn', 'note'] }, where: { type: 'string' }, detail: { type: 'string' } } } },
  },
}
const checks = await parallel([
  () => agent(
    'Adversarially VERIFY byte-identical error messages. For every entry in this code map, confirm the catalog en template in ' + ROOT + '/src/errors/catalog.ts, after {param} interpolation, reproduces the ORIGINAL message the class threw. Reconstruct the original by reading git: git show HEAD:<file> for the pre-migration constructor. Flag ANY drift (punctuation, spacing, quoting, param order) as a blocker. Code map:\n' + codeMapJson,
    { label: 'verify:byte-identical', phase: 'Verify', schema: VERDICT, effort: 'high' },
  ),
  () => agent(
    'Adversarially VERIFY status parity + boundary. Confirm: (a) each catalog status equals the status the error mapped to BEFORE this change (compare against git show HEAD:' + ROOT + '/src/http/uws.adapter.ts and read.router.ts and write.handler.ts instanceof chains); (b) toErrorResponse never leaks a non-AppError message (falls to 500 internal error); (c) the builder envelope still carries blocked/table/column/affected and Retry-After for the conflict code. Flag mismatches as blockers.',
    { label: 'verify:status+boundary', phase: 'Verify', schema: VERDICT, effort: 'high' },
  ),
  () => agent(
    'Adversarially VERIFY structural integrity. Confirm: (a) every former "extends Error" app error class now "extends AppError" across ' + ROOT + '/src and none were missed; (b) NO "throw new" site changed (per-class counts match the survey); (c) all extra public fields handlers read are still present; (d) src/errors/ and the converted files have no NEW tsc errors (cd ' + ROOT + ' && npx tsc -p tsconfig.json --noEmit 2>&1 | head -60). Flag any missed class or signature drift as a blocker.',
    { label: 'verify:structure', phase: 'Verify', schema: VERDICT, effort: 'high' },
  ),
])
const blockers = checks.filter(Boolean).flatMap((c) => (c.findings || []).filter((f) => f.severity === 'blocker'))
return {
  codes: design && design.codes ? design.codes.length : 0,
  filesWritten: design && design.filesWritten ? design.filesWritten : [],
  specialCases: design && design.specialCases ? design.specialCases : '',
  convertSummaries: conv.filter(Boolean).map((c) => typeof c === 'string' ? c.slice(0, 300) : c),
  wireSummaries: wire.filter(Boolean).map((w) => typeof w === 'string' ? w.slice(0, 300) : w),
  verifyOk: checks.filter(Boolean).map((c) => c.ok),
  blockers,
}
