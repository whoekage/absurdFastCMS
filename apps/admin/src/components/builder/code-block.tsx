import { Fragment, type ReactNode } from 'react';

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
function highlightLine(line: string): ReactNode {
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

/** A line-numbered, syntax-highlighted source block (no window chrome). */
export function CodeBlock({ source }: { source: string }) {
  const lines = source.split('\n');
  return (
    <div className="overflow-x-auto py-4">
      {lines.map((line, i) => (
        <div key={i} className="flex min-w-max">
          <span className="w-11 flex-shrink-0 select-none pe-4 text-end font-mono text-[12.5px]" style={{ color: 'var(--faint)' }}>
            {i + 1}
          </span>
          <span className="whitespace-pre font-mono text-[12.5px] leading-[1.9] text-foreground">{highlightLine(line)}</span>
        </div>
      ))}
    </div>
  );
}
