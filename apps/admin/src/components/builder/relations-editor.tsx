import { useState } from 'react';
import { Plus } from 'lucide-react';
import { type RelationDraft, emptyRelationDraft, relationStatus } from '@/lib/module-draft';
import { TONE_VAR, type FieldTone } from '@/lib/field-types';
import { RelationCard } from './relation-card';

interface RelationsEditorProps {
  relations: RelationDraft[];
  relationBaseline: Record<string, string>;
  onChange: (next: RelationDraft[]) => void;
  /** Display name of THIS module (the relation sentence subject). */
  moduleName: string;
  /** Candidate target module names (includes this module for self-refs). */
  targets: readonly string[];
  /** name → human label (target glyphs derive from the label). */
  targetLabels: Record<string, string>;
  /** name → its field names (the display-field chips per target). */
  targetFields: Record<string, string[]>;
}

const TONES: FieldTone[] = ['primary', 'info', 'warning', 'violet', 'pink', 'teal', 'success'];

/** A 2-letter glyph from a name ("Article" → "Ar", "blog_post" → "Bl"). */
function glyphFor(name: string): string {
  const clean = name.replace(/[^a-zA-Z0-9]/g, '');
  const two = clean.slice(0, 2) || '?';
  return two.charAt(0).toUpperCase() + two.slice(1);
}

/** Deterministic tone per module name (so a target keeps the same colour across cards). */
function toneFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return TONE_VAR[TONES[h % TONES.length] as FieldTone];
}

/**
 * The relations section: a card per top-level relation (collapsed sentence → inline 6-way editor) plus
 * an "Add relation" button. Relations save atomically with the module via the single PUT; the link table
 * is created server-side on apply. Soft-deleted relations stay (with a restore strip) until applied.
 */
export function RelationsEditor({ relations, relationBaseline, onChange, moduleName, targets, targetLabels, targetFields }: RelationsEditorProps) {
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const moduleGlyph = glyphFor(moduleName);
  const live = relations.filter((r) => !r.deleted);

  const setAt = (key: string, next: RelationDraft) => onChange(relations.map((r) => (r.key === key ? next : r)));

  const addRelation = () => {
    if (targets.length === 0) return;
    // Prefer a different module as the default target; fall back to a self-reference.
    const def = targets.find((t) => t !== moduleName) ?? targets[0]!;
    const draft = emptyRelationDraft(def);
    onChange([...relations, draft]);
    setExpandedKey(draft.key);
  };

  const deleteRelation = (key: string) => {
    onChange(
      relations.flatMap((r) => {
        if (r.key !== key) return [r];
        return r.id === undefined ? [] : [{ ...r, deleted: true }];
      }),
    );
    setExpandedKey(null);
  };

  const cycleTarget = (key: string) => {
    const r = relations.find((x) => x.key === key);
    if (!r || targets.length === 0) return;
    const idx = targets.indexOf(r.target);
    const next = targets[(idx + 1) % targets.length]!;
    // Target changed → its fields differ, so reset the chosen display field.
    setAt(key, { ...r, target: next, displayField: '' });
  };

  return (
    <div data-builder className="mt-[26px]">
      <div className="mx-1 mb-[11px] flex items-center justify-between">
        <div className="flex items-baseline gap-2.5">
          <h2 className="font-display text-[15px] font-semibold tracking-[-0.01em]">Relations</h2>
          <span className="font-mono text-[12px]" style={{ color: 'var(--faint)' }}>
            {live.length} {live.length === 1 ? 'relation' : 'relations'}
          </span>
        </div>
        <button
          type="button"
          onClick={addRelation}
          disabled={targets.length === 0}
          className="flex items-center gap-1.5 rounded-lg border px-[11px] py-1.5 text-[12.5px] font-semibold text-muted-foreground transition-colors hover:bg-[var(--fill)] hover:text-foreground disabled:opacity-50"
        >
          <Plus className="h-[13px] w-[13px]" />
          Relation
        </button>
      </div>

      <div className="flex flex-col gap-[7px]">
        {relations.map((draft) => (
          <RelationCard
            key={draft.key}
            draft={draft}
            status={relationStatus(draft, relationBaseline)}
            moduleName={moduleName}
            moduleGlyph={moduleGlyph}
            targetGlyph={glyphFor(targetLabels[draft.target] ?? draft.target)}
            targetTone={toneFor(draft.target)}
            targetFields={targetFields[draft.target] ?? []}
            expanded={expandedKey === draft.key}
            onToggle={() => setExpandedKey((cur) => (cur === draft.key ? null : draft.key))}
            onCycleTarget={() => cycleTarget(draft.key)}
            onChange={(next) => setAt(draft.key, next)}
            onDelete={() => deleteRelation(draft.key)}
            onRestore={() => setAt(draft.key, { ...draft, deleted: false })}
          />
        ))}

        {live.length === 0 && (
          <p className="px-1 text-[12.5px] text-muted-foreground">No relations yet. Link this module to another with “Relation”.</p>
        )}
      </div>
    </div>
  );
}
