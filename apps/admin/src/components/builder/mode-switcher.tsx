import { Rows3, Eye, Code2 } from 'lucide-react';

export type BuilderMode = 'build' | 'preview' | 'code';

const MODES: { key: BuilderMode; label: string; Icon: typeof Rows3 }[] = [
  { key: 'build', label: 'Build', Icon: Rows3 },
  { key: 'preview', label: 'Preview', Icon: Eye },
  { key: 'code', label: 'Code', Icon: Code2 },
];

/**
 * The floating Build / Preview / Code switcher — a dark glassy pill pinned bottom-center over the canvas
 * (Lua design). Active segment lifts to white-on-overlay.
 */
export function ModeSwitcher({ mode, onChange }: { mode: BuilderMode; onChange: (m: BuilderMode) => void }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-20 flex justify-center pb-5 pt-3.5">
      <div
        className="pointer-events-auto inline-flex gap-[3px] rounded-[14px] border p-[5px] backdrop-blur-xl"
        style={{ background: 'rgba(22,21,28,0.9)', borderColor: 'rgba(255,255,255,0.13)', boxShadow: '0 12px 34px rgba(0,0,0,0.34)' }}
      >
        {MODES.map(({ key, label, Icon }) => {
          const active = mode === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => onChange(key)}
              className="flex items-center gap-[7px] rounded-[10px] border-none px-4 py-[9px] text-[12.5px] font-semibold transition-colors"
              style={{
                background: active ? 'rgba(255,255,255,0.15)' : 'transparent',
                color: active ? '#ffffff' : 'rgba(255,255,255,0.58)',
              }}
            >
              <Icon className="h-[15px] w-[15px]" />
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
