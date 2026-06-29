import type { ReactNode } from 'react';
import { Eye } from 'lucide-react';
import { BuilderHeader } from './builder-header';

interface BuilderShellProps {
  mode: 'create' | 'edit';
  /** Machine name (empty on a brand-new module). */
  name: string;
  label?: string | undefined;
  /** Header right-slot (Review CTA / undo-redo / switcher — later stages). */
  headerRight?: ReactNode;
  /** Right preview rail content; a placeholder until Stage 4 wires the live preview. */
  preview?: ReactNode;
  /** Left editor pane. */
  children: ReactNode;
}

/**
 * The full-viewport module-builder frame: own header + a two-pane body (fluid left editor centered
 * at 740px, fixed 430px right preview rail). Renders outside the app sidebar (see __root.tsx). The
 * field/relation/preview internals are filled in by later stages; Stage 0 hosts the existing
 * `ModuleForm` in the left pane and a preview placeholder on the right.
 */
export function BuilderShell({ mode, name, label, headerRight, preview, children }: BuilderShellProps) {
  return (
    <div className="flex h-screen w-full flex-col overflow-hidden bg-background text-foreground">
      <BuilderHeader mode={mode} name={name} label={label} right={headerRight} />
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[740px] px-7 pb-20 pt-6">{children}</div>
        </div>
        <aside
          className="flex w-[430px] flex-shrink-0 flex-col border-l"
          style={{ background: 'color-mix(in srgb, hsl(var(--muted)) 40%, transparent)' }}
        >
          {preview ?? <PreviewPlaceholder />}
        </aside>
      </div>
    </div>
  );
}

function PreviewPlaceholder() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center" style={{ color: 'var(--faint)' }}>
      <Eye className="h-6 w-6" />
      <p className="text-sm font-medium">Live preview</p>
      <p className="text-xs">“What an editor sees” — lands in a later stage.</p>
    </div>
  );
}
