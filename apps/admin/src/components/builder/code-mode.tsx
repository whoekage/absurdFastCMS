import { Fragment, type ReactNode } from 'react';
import { Check } from 'lucide-react';

/** Token classes → design colour vars (JetBrains-y palette). */
const COLOR = {
  comment: 'var(--faint)',
  string: 'var(--success)',
  call: 'var(--info)',
  keyword: 'var(--violet)',
  number: 'var(--info)',
} as const;

// One pass; groups in priority order: comment, string, c.method, keyword, number.
const TOKEN = /(\/\/[^\n]*)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")|(\bc\.[a-zA-Z]+)|\b(import|export|default|from|const|as|true|false|null)\b|\b(\d+(?:\.\d+)?)\b/g;

/** Syntax-highlight one source line into coloured spans (best-effort, preview-only). */
function highlight(line: string): ReactNode {
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  TOKEN.lastIndex = 0;
  let k = 0;
  while ((m = TOKEN.exec(line)) !== null) {
    if (m.index > last) out.push(<Fragment key={`p${k++}`}>{line.slice(last, m.index)}</Fragment>);
    const color = m[1] ? COLOR.comment : m[2] ? COLOR.string : m[3] ? COLOR.call : m[4] ? COLOR.keyword : COLOR.number;
    out.push(
      <span key={`t${k++}`} style={{ color }}>
        {m[0]}
      </span>,
    );
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push(<Fragment key={`p${k++}`}>{line.slice(last)}</Fragment>);
  return out;
}

/**
 * The "Code" canvas mode: a faux editor window (traffic lights + filename + read-only badge) showing the
 * live `schema.ts` source with a line-number gutter and lightweight syntax highlighting. The source is the
 * client mirror; the AUTHORITATIVE artifact is the server's generatedSource shown at Review.
 */
export function CodeMode({ source, filename }: { source: string; filename: string }) {
  const lines = source.split('\n');
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
        <div className="overflow-x-auto py-4">
          {lines.map((line, i) => (
            <div key={i} className="flex min-w-max">
              <span className="w-11 flex-shrink-0 select-none pe-4 text-end font-mono text-[12.5px]" style={{ color: 'var(--faint)' }}>
                {i + 1}
              </span>
              <span className="whitespace-pre font-mono text-[12.5px] leading-[1.9] text-foreground">{highlight(line)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
