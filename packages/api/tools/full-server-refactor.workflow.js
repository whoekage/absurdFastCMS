export const meta = {
  name: 'full-server-required-deps',
  description: 'Make createServer require all deps (delete the ~10 capability if-branches that are always-true in prod), and design tests for reality: one startTestServer harness assembles the FULL real server + bootstraps a super-admin + returns an authenticated fetch; every e2e test uses it; partial-mode (read-only / no-auth) tests are deleted; isolated units stay unit-tested. Incrementally green: build the harness first (additive), migrate tests while createServer is still optional, tighten createServer LAST.',
  phases: [
    { title: 'Survey', detail: 'enumerate capability branches + every server-booting test + the prod assembly to mirror' },
    { title: 'Design+Harness', detail: 'write the unified startTestServer harness + ServerDeps; return per-file migration recipes (max effort)' },
    { title: 'Migrate', detail: 'route each test file through the harness + authed fetch; delete partial-mode tests (parallel by file)' },
    { title: 'Tighten', detail: 'createServer(deps) required + delete branches + conti.ts + collapse old helpers' },
  ],
}

const ROOT = 'packages/api'
const RULES = [
  'CONTEXT: ' + ROOT + '/src/http/server.ts exposes createServer(engine, store?, registry?, publishClock?, auth?, sessionCache?, rbac?, teamView?, hooks?, modulesDir?). Everything after engine is optional, and ~10 if-branches gate route registration / request handling on presence (store && registry -> write+media+builder routes; authEnabled = sessionCache && rbac -> the RBAC gate; auth !== undefined -> mount /auth/*; teamView !== undefined -> team routes; modulesDir !== undefined -> builder routes; reg===undefined||store===undefined -> mediaRead early-out; etc.).',
  'PROD REALITY: the ONLY non-test caller is ' + ROOT + '/src/compose/conti.ts, which ALWAYS passes every dep. So in production all those branches are ALWAYS true. The optionality exists only so tests boot partial servers.',
  'GOAL: make all deps REQUIRED (a ServerDeps object), DELETE the always-true branches, and have tests assemble the FULL real server. Reads stay PUBLIC even on the gated server; only WRITES/builder/media need auth.',
  'HARNESS: a single startTestServer(sql, schemas, opts?) assembles the full real server (mirroring conti.ts: real buildAuth + SessionCache + RbacRegistry + TeamView + HookRegistry + a temp modulesDir), bootstraps a super-admin (the FIRST sign-up becomes super-admin via the first-admin advisory-lock bootstrap), captures its session cookie, and returns an AUTHENTICATED fetch so write tests just work transparently. The existing ' + ROOT + '/test/helpers.ts startTestServerFromFilesWithAuth already wires real auth + signUp/grantRole/userIdOf — REUSE that machinery.',
  'INCREMENTAL GREEN: do NOT change the createServer signature until the LAST phase. Build the harness additively (it calls createServer with ALL deps, valid under the current optional signature). Migrate every test to the harness while createServer is still optional (so each file stays green independently). Only AFTER all callers pass everything, tighten createServer to require ServerDeps and delete the branches.',
  'HARD INVARIANTS (from the project): REAL Postgres only, NEVER mocks; test env = .env.test; commit nothing (the orchestrator commits); run a test file with: node --conditions=source --env-file=.env.test --test --test-global-setup=./test/global-setup.ts <file>  (run from ' + ROOT + ').',
]
const RULES_TEXT = RULES.join('\n')

// ----------------------------------------------------------------------------------------------- SURVEY
phase('Survey')
const BRANCHES_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['branches'],
  properties: {
    branches: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['line', 'gates', 'collapsesTo'],
      properties: {
        line: { type: 'number' }, gates: { type: 'string', description: 'which dep + what it registers/guards' },
        collapsesTo: { type: 'string', description: 'what the code becomes when the dep is REQUIRED (unconditional body, or DELETE the guard)' },
      },
    } },
  },
}
const TESTS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['files'],
  properties: {
    files: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['file', 'boots', 'doesWrites', 'partialModeOnly', 'requestStyle', 'plan'],
      properties: {
        file: { type: 'string' },
        boots: { type: 'string', description: 'how it currently boots a server (which helper or raw createServer + what it passes)' },
        doesWrites: { type: 'boolean', description: 'does it POST/PUT/DELETE (will need the authed fetch)' },
        partialModeOnly: { type: 'boolean', description: 'true if its assertions ONLY make sense for a partial server (read-only / no-auth / open-server) that no longer ships -> DELETE the file or those tests' },
        requestStyle: { type: 'string', description: 'raw fetch(`${base}/...`) vs a client vs a helper' },
        plan: { type: 'string', description: 'concrete migration: boot-swap + which calls become authed + what to delete' },
      },
    } },
  },
}
const ASSEMBLY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['prodAssembly', 'authHarness', 'bootstrapAdmin'],
  properties: {
    prodAssembly: { type: 'string', description: 'the exact dep-construction sequence conti.ts uses (buildAuth/setAuthSql/SessionCache/RbacRegistry/TeamView/HookRegistry/modulesDir) the harness must mirror' },
    authHarness: { type: 'string', description: 'what startTestServerFromFilesWithAuth already provides (signUp/grantRole/userIdOf, how it builds auth) to reuse' },
    bootstrapAdmin: { type: 'string', description: 'how the first-admin bootstrap works + how to capture the session cookie from sign-up to build an authed fetch' },
  },
}
const [branchSurvey, testSurvey, assemblySurvey] = await parallel([
  () => agent(RULES_TEXT + '\n\nSURVEY the capability branches. Read ' + ROOT + '/src/http/server.ts (the createServer function, ~line 360 onward). Enumerate EVERY if-branch / ternary / early-return that exists ONLY because a dep is optional (store/registry/auth/sessionCache/rbac/teamView/hooks/modulesDir). For each: its line, what it gates, and what the code collapses to once that dep is REQUIRED (the unconditional body, or "delete the guard"). Be exhaustive.', { label: 'survey:branches', phase: 'Survey', schema: BRANCHES_SCHEMA, effort: 'high' }),
  () => agent(RULES_TEXT + '\n\nSURVEY every test that boots a server. List EVERY file under ' + ROOT + '/test that calls createServer (directly or via a helper) — grep "createServer(" and the helpers startTestServerFromSchemas/FromFiles/FromFilesWithAuth. For each file: how it boots, whether it does writes (POST/PUT/DELETE), whether it ONLY tests a partial-mode behavior that no longer ships (a read-only server, an un-gated/open server) -> mark partialModeOnly, its request style (raw fetch vs client), and a concrete migration plan. Include helpers.ts itself.', { label: 'survey:tests', phase: 'Survey', schema: TESTS_SCHEMA, effort: 'high' }),
  () => agent(RULES_TEXT + '\n\nSURVEY the prod assembly + the existing auth harness so the new startTestServer can mirror them. Read ' + ROOT + '/src/compose/conti.ts (the dep construction before createServer) and ' + ROOT + '/test/helpers.ts startTestServerFromFilesWithAuth (lines ~126-180) + its signUp/grantRole. Extract: (1) the exact sequence to build auth/sessionCache/rbac/teamView/hooks/modulesDir, (2) what the auth harness already gives, (3) how the first-admin bootstrap works and how to capture the sign-up session cookie to build an authenticated fetch.', { label: 'survey:assembly', phase: 'Survey', schema: ASSEMBLY_SCHEMA, effort: 'high' }),
])
log('survey: ' + ((branchSurvey && branchSurvey.branches) || []).length + ' branches, ' + ((testSurvey && testSurvey.files) || []).length + ' test files')

// ----------------------------------------------------------------------------------------------- DESIGN + HARNESS
phase('Design+Harness')
const DESIGN_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['harnessApi', 'serverDeps', 'collapsePlan', 'migrations', 'deletions', 'filesWritten'],
  properties: {
    harnessApi: { type: 'string', description: 'the exact startTestServer(sql, schemas, opts?) signature + what it returns (base, close, token, sql, engine, registry, fetch [authed], anonFetch, signUp, grantRole, sessionCache, rbac, applyEdit)' },
    serverDeps: { type: 'string', description: 'the ServerDeps interface (all required except publishClock default) that createServer will take in the Tighten phase' },
    collapsePlan: { type: 'string', description: 'per-branch: exactly how each surveyed branch collapses when deps are required (for the Tighten phase)' },
    migrations: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['file', 'recipe'],
      properties: { file: { type: 'string' }, recipe: { type: 'string', description: 'concrete steps: swap boot to startTestServer; route writes through the authed fetch; reads stay; delete partial-mode tests; any auth-specific adjustments' } },
    } },
    deletions: { type: 'array', items: { type: 'string' }, description: 'files or tests to delete (partial-mode-only)' },
    filesWritten: { type: 'array', items: { type: 'string' } },
  },
}
const design = await agent(
  RULES_TEXT + '\n\nYou are the lead engineer. Using the three surveys below, (1) WRITE the unified harness startTestServer into ' + ROOT + '/test/helpers.ts (or a new ' + ROOT + '/test/server.harness.ts imported by helpers.ts), ADDITIVELY — do NOT change createServer yet, do NOT break the existing helpers. It must: assemble the FULL real server (mirror conti.ts assembly), bootstrap a super-admin (first sign-up -> super-admin), capture the session cookie, and return an AUTHENTICATED fetch(path, init?) plus an anonFetch(path, init?) (no creds) plus { base, close, token, sql, engine, registry, signUp, grantRole, sessionCache, rbac, applyEdit }. Reads are public; the authed fetch carries the admin cookie so writes work. (2) Type the ServerDeps interface you will use in the Tighten phase (all deps required, publishClock optional with a default). (3) Produce the per-file migration recipes (one per surveyed test file) and the per-branch collapse plan. (4) Run "cd ' + ROOT + ' && npx tsc -p tsconfig.json --noEmit 2>&1 | head -30" and make sure your new harness type-checks. Do NOT migrate tests or touch createServer here.\n\n' +
  'BRANCH SURVEY:\n' + JSON.stringify(branchSurvey) + '\n\nTEST SURVEY:\n' + JSON.stringify(testSurvey) + '\n\nASSEMBLY SURVEY:\n' + JSON.stringify(assemblySurvey),
  { label: 'design+harness', phase: 'Design+Harness', schema: DESIGN_SCHEMA, effort: 'max' },
)
log('harness written: ' + ((design && design.filesWritten) || []).join(', ') + '; ' + ((design && design.migrations) || []).length + ' files to migrate')

// ----------------------------------------------------------------------------------------------- MIGRATE (parallel by file)
phase('Migrate')
const migrations = (design && design.migrations) ? design.migrations : []
const harnessApi = (design && design.harnessApi) ? design.harnessApi : ''
const migrated = await parallel(migrations.map((m) => () =>
  agent(
    RULES_TEXT + '\n\nMigrate ONE test file to the unified harness. File: ' + m.file + '\n' +
    'Harness API (already written, import from test/helpers.ts):\n' + harnessApi + '\n\n' +
    'Recipe:\n' + m.recipe + '\n\n' +
    'Steps: swap its server boot to startTestServer(sql, schemas) (assembling the FULL server); route every WRITE request (POST/PUT/DELETE, and builder/media writes) through the harness AUTHED fetch so the gate passes; reads can stay public; for any test that asserts a partial-mode behavior that no longer ships (read-only server, open/un-gated server) DELETE that test; for tests that explicitly check 401/403 use anonFetch. Keep the test INTENT identical otherwise. createServer is STILL optional at this point, so the harness works. ' +
    'After editing, RUN this file: cd ' + ROOT + ' && node --conditions=source --env-file=.env.test --test --test-global-setup=./test/global-setup.ts ' + m.file + ' 2>&1 | tail -15  — and confirm it passes (or report the exact failure). Return a one-paragraph summary + pass/fail.',
    { label: 'migrate:' + m.file.split('/').slice(-1)[0], phase: 'Migrate', effort: 'high' },
  )
))
log('migrated ' + migrated.filter(Boolean).length + '/' + migrations.length + ' test files')

// ----------------------------------------------------------------------------------------------- TIGHTEN
phase('Tighten')
const collapsePlan = (design && design.collapsePlan) ? design.collapsePlan : ''
const serverDeps = (design && design.serverDeps) ? design.serverDeps : ''
const tighten = await parallel([
  () => agent(
    RULES_TEXT + '\n\nTIGHTEN the core now that EVERY caller passes all deps. In ' + ROOT + '/src/http/server.ts: change createServer to take a single required ServerDeps object (engine, store, registry, auth, sessionCache, rbac, teamView, hooks, modulesDir all REQUIRED; publishClock optional with a default). DELETE the now-always-true capability branches per the collapse plan (make their bodies unconditional). Then update the ONE prod caller ' + ROOT + '/src/compose/conti.ts to pass the deps object, and update the harness/helpers in ' + ROOT + '/test/helpers.ts to construct createServer via the deps object. ServerDeps:\n' + serverDeps + '\n\nCollapse plan:\n' + collapsePlan + '\n\n' +
    'Run: cd ' + ROOT + ' && npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E "^src/" | grep -viE "bench/|test/" | head  — and confirm 0 src errors. Return what changed + the final createServer signature.',
    { label: 'tighten:createServer', phase: 'Tighten', effort: 'max' },
  ),
])
const delList = (design && design.deletions) ? design.deletions : []

return {
  branches: ((branchSurvey && branchSurvey.branches) || []).length,
  harnessWritten: (design && design.filesWritten) || [],
  migratedFiles: migrations.map((m) => m.file),
  migrateSummaries: migrated.filter(Boolean).map((s) => typeof s === 'string' ? s.slice(0, 300) : s),
  deletions: delList,
  tightenSummary: tighten.filter(Boolean).map((t) => typeof t === 'string' ? t.slice(0, 400) : t),
  serverDeps: serverDeps,
}
