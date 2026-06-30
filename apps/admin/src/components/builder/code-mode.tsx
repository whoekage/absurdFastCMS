import { Check } from 'lucide-react';
import { CodeBlock } from './code-block';

/**
 * The "Code" canvas mode: a faux editor window (traffic lights + filename + read-only badge) showing the
 * live `schema.ts` source via the shared {@link CodeBlock}. The source is the client mirror; the
 * AUTHORITATIVE artifact is the server's generatedSource shown at Review.
 */
export function CodeMode({ source, filename }: { source: string; filename: string }) {
  return (
    <div className="mx-auto max-w-[800px]" style={{ animation: 'lmbUp .3s ease' }}>
      <div className="overflow-hidden rounded-[13px] border shadow-card" style={{ background: 'var(--code-bg)' }}>
        <div className="flex items-center gap-2 border-b px-[15px] py-[11px]" style={{ background: 'color-mix(in srgb, hsl(var(--muted)) 50%, transparent)' }}>
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: '#f43f5e' }} />
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: '#f59e0b' }} />
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: '#10b981' }} />
          <span className="ml-[7px] font-mono text-[12px] text-muted-foreground">{filename}</span>
          <span className="flex-1" />
          <span className="flex items-center gap-1.5 text-[10.5px]" style={{ color: 'var(--faint)' }}>
            <Check className="h-[11px] w-[11px]" />
            generated · read-only
          </span>
        </div>
        <CodeBlock source={source} />
      </div>
    </div>
  );
}
