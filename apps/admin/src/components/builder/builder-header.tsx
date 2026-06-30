import { Link, useNavigate } from "@tanstack/react-router";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Moon,
  Plus,
  Redo2,
  Sun,
  Undo2,
} from "lucide-react";
import type { ReactNode } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTheme } from "@/lib/theme";

/** A module the switcher can jump to. */
export interface SwitchableModule {
  name: string;
  label?: string | undefined;
}

interface BuilderHeaderProps {
  mode: "create" | "edit";
  /** Machine name (empty on create). */
  name: string;
  label?: string | undefined;
  /** Whether the form has unsaved changes (drives amber status dot). */
  dirty?: boolean;
  busy?: boolean;
  /** All modules, for the edit-mode switcher dropdown. */
  modules?: SwitchableModule[] | undefined;
  /** Undo/redo wiring (edit mode). */
  canUndo?: boolean | undefined;
  canRedo?: boolean | undefined;
  onUndo?: (() => void) | undefined;
  onRedo?: (() => void) | undefined;
  /** Slot for the Review CTA (edit mode only). */
  right?: ReactNode;
}

/** Short 2-char mono glyph for the module chip ("Article" → "Ar"). */
function glyphOf(s: string): string {
  const clean = s.replace(/[^a-zA-Z0-9]/g, "");
  const two = clean.slice(0, 2) || s.slice(0, 2) || "M";
  return two.charAt(0).toUpperCase() + (two[1] ?? "").toLowerCase();
}

/**
 * Compact per-screen builder header (56px). Create mode: simple breadcrumb. Edit mode: back button +
 * module glyph chip + name + api ID + undo/redo + draft status dot + Review CTA slot + theme toggle.
 */
export function BuilderHeader({
  mode,
  name,
  label,
  dirty = false,
  busy = false,
  modules = [],
  canUndo = false,
  canRedo = false,
  onUndo,
  onRedo,
  right,
}: BuilderHeaderProps) {
  const { resolvedTheme, setTheme } = useTheme();
  const navigate = useNavigate();
  const display = label?.trim() || name || "Untitled";
  const apiId = name ? `api::${name}.${name}` : "";

  return (
    <header
      className="flex h-14 flex-shrink-0 items-center gap-3 border-b px-[22px]"
      style={{ background: "hsl(var(--background))" }}
    >
      {mode === "create" ? (
        /* ── Create: "← modules / new" breadcrumb ── */
        <div className="flex items-center gap-2">
          <Link
            to="/modules"
            className="flex items-center gap-1.5 font-mono text-[12px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronLeft className="h-[14px] w-[14px]" />
            modules
          </Link>
          <ChevronRight className="h-3 w-3 text-muted-foreground/40" />
          <span className="font-display text-[15px] font-semibold">new</span>
        </div>
      ) : (
        /* ── Edit: back + glyph chip + name + api ID + undo/redo + status + CTA ── */
        <>
          <Link
            to="/modules"
            className="flex h-[30px] w-[30px] flex-shrink-0 items-center justify-center rounded-[8px] border bg-card text-muted-foreground transition-colors hover:text-foreground"
            aria-label="Back to modules"
          >
            <ChevronLeft className="h-[15px] w-[15px]" />
          </Link>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="group flex items-center gap-[10px] rounded-[8px] px-[5px] py-1 transition-colors hover:bg-accent focus-visible:outline-none"
                aria-label="Switch module"
              >
                <span
                  className="flex h-[26px] w-[26px] flex-shrink-0 items-center justify-center rounded-[7px] font-mono text-[11px] font-semibold"
                  style={{
                    background: "color-mix(in srgb, hsl(var(--primary)) 15%, transparent)",
                    color: "hsl(var(--primary))",
                  }}
                >
                  {glyphOf(display)}
                </span>
                <span className="flex items-baseline gap-[10px]">
                  <span className="font-display text-[20px] font-semibold tracking-[-0.02em] leading-none">
                    {display}
                  </span>
                  {apiId && (
                    <span className="font-mono text-[11.5px] text-muted-foreground">{apiId}</span>
                  )}
                </span>
                <ChevronDown className="h-[15px] w-[15px] text-muted-foreground/60 transition-colors group-hover:text-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[220px]">
              {modules.map((m) => {
                const active = m.name === name;
                return (
                  <DropdownMenuItem
                    key={m.name}
                    onSelect={() => {
                      if (!active) void navigate({ to: "/modules/$name", params: { name: m.name } });
                    }}
                    className="gap-[10px]"
                    style={active ? { background: "hsl(var(--accent))" } : undefined}
                  >
                    <span
                      className="flex h-[22px] w-[22px] flex-shrink-0 items-center justify-center rounded-[6px] font-mono text-[10px] font-semibold"
                      style={{
                        background: "color-mix(in srgb, hsl(var(--primary)) 13%, transparent)",
                        color: "hsl(var(--primary))",
                      }}
                    >
                      {glyphOf(m.label?.trim() || m.name)}
                    </span>
                    <span className="flex-1 truncate font-medium">{m.label?.trim() || m.name}</span>
                    {active && (
                      <span className="font-mono text-[10px] text-muted-foreground">current</span>
                    )}
                  </DropdownMenuItem>
                );
              })}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => void navigate({ to: "/modules/new" })}
                className="gap-[10px] text-muted-foreground"
              >
                <span className="flex h-[22px] w-[22px] flex-shrink-0 items-center justify-center rounded-[6px] border border-dashed">
                  <Plus className="h-[13px] w-[13px]" />
                </span>
                <span className="font-medium">New module</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <div className="flex-1" />

          {/* Undo / Redo */}
          <div className="flex items-center gap-[1px]">
            <button
              type="button"
              disabled={!canUndo}
              onClick={onUndo}
              aria-label="Undo"
              title="Undo (⌘Z)"
              className="flex h-[29px] w-[29px] items-center justify-center rounded-[7px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
            >
              <Undo2 className="h-[14px] w-[14px]" />
            </button>
            <button
              type="button"
              disabled={!canRedo}
              onClick={onRedo}
              aria-label="Redo"
              title="Redo (⌘⇧Z)"
              className="flex h-[29px] w-[29px] items-center justify-center rounded-[7px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-25"
            >
              <Redo2 className="h-[14px] w-[14px]" />
            </button>
          </div>

          {/* Draft status indicator */}
          {dirty && (
            <span
              className="flex items-center gap-1.5 font-mono text-[11px]"
              style={{ color: "var(--amber, #c77d1a)" }}
            >
              <span
                className="h-[6px] w-[6px] rounded-full"
                style={{ background: "var(--amber, #c77d1a)" }}
              />
              {busy ? "applying…" : "draft"}
            </span>
          )}

          {/* Review CTA slot (passed by the route / ModuleForm) */}
          {right}
        </>
      )}

      <div className="flex-1" />

      {/* Theme toggle */}
      <button
        type="button"
        aria-label="Toggle theme"
        onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
        className="flex h-[30px] w-[30px] flex-shrink-0 items-center justify-center rounded-[8px] border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        {resolvedTheme === "dark" ? (
          <Sun className="h-[15px] w-[15px]" />
        ) : (
          <Moon className="h-[15px] w-[15px]" />
        )}
      </button>
    </header>
  );
}
