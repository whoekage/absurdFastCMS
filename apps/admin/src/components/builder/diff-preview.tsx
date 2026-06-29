import { AlertTriangle, Check, Lock, GitCommit } from 'lucide-react';
import type { Change, ChangeRisk, PreviewResult } from '@/lib/builder-client';

/** A blocked change is FORBIDDEN (can never apply) vs. merely DESTRUCTIVE/data-dependent (apply w/ ack). */
export function hasForbidden(preview: PreviewResult): boolean {
  return preview.blocked.some((c) => c.risk === 'forbidden');
}

/** A short human label for a change kind (camelCase → words). */
function describeKind(kind: string): string {
  return kind.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

const RISK_STYLE: Record<ChangeRisk, string> = {
  safe: 'bg-muted text-muted-foreground',
  'data-dependent': 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  destructive: 'bg-destructive/15 text-destructive',
  forbidden: 'bg-destructive/15 text-destructive',
};

function ChangeRow({ change }: { change: Change }) {
  return (
    <li className="flex items-center gap-2 text-sm">
      <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${RISK_STYLE[change.risk]}`}>
        {change.risk}
      </span>
      <span className="font-medium">{describeKind(change.kind)}</span>
      {change.field && <span className="text-muted-foreground">· {change.field}</span>}
      {change.detail && <span className="text-muted-foreground">— {change.detail}</span>}
    </li>
  );
}

interface DiffPreviewProps {
  preview: PreviewResult;
  /** Module name — used in the "commit this file" reminder. */
  name: string;
  allowDestructive: boolean;
  onAllowDestructiveChange: (value: boolean) => void;
}

/**
 * Renders a dry-run {@link PreviewResult}: the SAFE changes that would apply, the BLOCKED ones (destructive
 * / data-dependent → gated behind an explicit "apply anyway" ack; FORBIDDEN → can never apply), the
 * generated `schema.ts` source, and a dev-time reminder to commit that file to git (the source of truth).
 */
export function DiffPreview({ preview, name, allowDestructive, onAllowDestructiveChange }: DiffPreviewProps) {
  const blocked = preview.blocked;
  const forbidden = blocked.filter((c) => c.risk === 'forbidden');
  const ackable = blocked.filter((c) => c.risk !== 'forbidden');
  const noChanges = preview.applied.length === 0 && blocked.length === 0;

  return (
    <div className="space-y-4">
      {noChanges && <p className="text-sm text-muted-foreground">No changes — this module already matches.</p>}

      {preview.applied.length > 0 && (
        <div className="space-y-2">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold">
            <Check className="h-4 w-4 text-emerald-600" />
            Will apply ({preview.applied.length})
          </h3>
          <ul className="space-y-1">
            {preview.applied.map((c, i) => (
              <ChangeRow key={`a-${i}`} change={c} />
            ))}
          </ul>
        </div>
      )}

      {ackable.length > 0 && (
        <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-destructive">
            <AlertTriangle className="h-4 w-4" />
            Destructive — needs confirmation ({ackable.length})
          </h3>
          <ul className="space-y-1">
            {ackable.map((c, i) => (
              <ChangeRow key={`d-${i}`} change={c} />
            ))}
          </ul>
          <label className="flex items-start gap-2 pt-1 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 rounded border-input"
              checked={allowDestructive}
              onChange={(e) => onAllowDestructiveChange(e.target.checked)}
            />
            <span>I understand this permanently changes or deletes data, and want to apply it anyway.</span>
          </label>
        </div>
      )}

      {forbidden.length > 0 && (
        <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-destructive">
            <Lock className="h-4 w-4" />
            Not allowed ({forbidden.length})
          </h3>
          <ul className="space-y-1">
            {forbidden.map((c, i) => (
              <ChangeRow key={`f-${i}`} change={c} />
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            These changes can't be applied through the builder (e.g. an unsupported type change). Edit the
            schema file by hand or split the change.
          </p>
        </div>
      )}

      <details className="rounded-md border">
        <summary className="cursor-pointer px-3 py-2 text-sm font-medium">Generated source</summary>
        <pre className="overflow-x-auto border-t bg-muted/40 p-3 text-xs leading-relaxed">
          <code>{preview.generatedSource}</code>
        </pre>
      </details>

      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <GitCommit className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          On apply, the server writes <code className="text-foreground">modules/{name}/schema.ts</code> and
          migrates the database. Commit that file to git — it is the source of truth (a fresh deploy rebuilds
          from it).
        </span>
      </p>
    </div>
  );
}
