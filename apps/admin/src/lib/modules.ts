// Module-introspection query keys (files-first). The old lib/content-types.ts also held the runtime-DDL
// Builder FORM helpers (FieldDraft, validateIdentifier, lowering to a FieldSpec) — those were removed with
// the Builder UI (schema mutation is files-first now: edit schema/<apiId>.json). All that survives is the
// read-side query-key namespace + the shared error-message extractor.
export { errorMessage } from '@/lib/errors';

/** TanStack Query keys for files-first module introspection (`api.modules.list/get`). */
export const moduleKeys = {
  all: ['modules'] as const,
  list: () => ['modules', 'list'] as const,
  detail: (apiId: string) => ['modules', 'detail', apiId] as const,
};
