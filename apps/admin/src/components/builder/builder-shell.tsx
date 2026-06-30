import type { ReactNode } from "react";
import { Sidebar } from "@/components/shell/sidebar";
import { BuilderHeader, type SwitchableModule } from "./builder-header";

interface BuilderShellProps {
  mode: "create" | "edit";
  /** Machine name (empty on a brand-new module). */
  name: string;
  label?: string | undefined;
  /** Whether the form has unsaved changes (drives header status indicator). */
  dirty?: boolean;
  /** Whether an async operation (review/apply) is in progress. */
  busy?: boolean;
  /** Number of pending field/relation changes (shown in header status). */
  pendingCount?: number;
  /** All modules, for the edit-mode header switcher. */
  modules?: SwitchableModule[] | undefined;
  /** Undo/redo wiring (edit mode). */
  canUndo?: boolean | undefined;
  canRedo?: boolean | undefined;
  onUndo?: (() => void) | undefined;
  onRedo?: (() => void) | undefined;
  /** Header right-slot: Review CTA + any extra actions (wired by the route). */
  headerRight?: ReactNode;
  /** The canvas (Build / Preview / Code modes switched inside ModuleForm). */
  children: ReactNode;
}

/**
 * The module-builder frame: standard sidebar (left) + compact per-screen header + scrollable canvas
 * (right). Matches the Lua flow v2 design — 240px sidebar is always visible in the builder.
 */
export function BuilderShell({ mode, name, label, dirty = false, busy = false, modules, canUndo, canRedo, onUndo, onRedo, headerRight, children }: BuilderShellProps) {
  return (
    <div
      data-builder
      className="flex h-screen w-full overflow-hidden bg-background text-foreground"
    >
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <BuilderHeader
          mode={mode}
          name={name}
          label={label}
          dirty={dirty}
          busy={busy}
          modules={modules}
          canUndo={canUndo}
          canRedo={canRedo}
          onUndo={onUndo}
          onRedo={onRedo}
          right={headerRight}
        />
        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[860px] px-7 pb-28 pt-6">{children}</div>
        </main>
      </div>
    </div>
  );
}
