import type { ReactNode } from 'react';
import { BuilderHeader } from './builder-header';

interface BuilderShellProps {
  mode: 'create' | 'edit';
  /** Machine name (empty on a brand-new module). */
  name: string;
  label?: string | undefined;
  /** Header right-slot (Review CTA / undo-redo / switcher — later stages). */
  headerRight?: ReactNode;
  /** The full-width canvas (Build / Preview / Code modes are switched inside {@link ModuleForm}). */
  children: ReactNode;
}

/**
 * The full-viewport module-builder frame: own 56px header + a single full-width scroll canvas centered
 * at ~740px. The Build / Preview / Code modes (and the floating mode switcher) live inside the canvas
 * (ModuleForm), matching the Lua design — there is no fixed side rail.
 */
export function BuilderShell({ mode, name, label, headerRight, children }: BuilderShellProps) {
  return (
    <div data-builder className="flex h-screen w-full flex-col overflow-hidden bg-background text-foreground">
      <BuilderHeader mode={mode} name={name} label={label} right={headerRight} />
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[840px] px-7 pb-28 pt-6">{children}</div>
      </main>
    </div>
  );
}
