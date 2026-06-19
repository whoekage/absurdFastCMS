import * as React from 'react';
import { CheckCircle2, X, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

// A tiny, dependency-free toast system (we don't pull in `sonner` to avoid a new install step).
// Mount <Toaster /> once near the root, then call `toast.success(...)` / `toast.error(...)`.

type ToastVariant = 'success' | 'error' | 'info';

interface ToastItem {
  id: number;
  message: string;
  variant: ToastVariant;
}

type Listener = (toasts: ToastItem[]) => void;

let toasts: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l(toasts);
}

function push(message: string, variant: ToastVariant) {
  const id = nextId++;
  toasts = [...toasts, { id, message, variant }];
  emit();
  setTimeout(() => dismiss(id), 4000);
}

function dismiss(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

export const toast = {
  success: (message: string) => push(message, 'success'),
  error: (message: string) => push(message, 'error'),
  info: (message: string) => push(message, 'info'),
};

const variantStyles: Record<ToastVariant, string> = {
  success: 'border-green-500/40 bg-background text-foreground',
  error: 'border-destructive/50 bg-background text-foreground',
  info: 'border-border bg-background text-foreground',
};

function VariantIcon({ variant }: { variant: ToastVariant }) {
  if (variant === 'success') return <CheckCircle2 className="h-4 w-4 text-green-600" />;
  if (variant === 'error') return <XCircle className="h-4 w-4 text-destructive" />;
  return null;
}

export function Toaster() {
  const [items, setItems] = React.useState<ToastItem[]>(toasts);

  React.useEffect(() => {
    const listener: Listener = (next) => setItems(next);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  return (
    <div className="fixed bottom-4 right-4 z-[100] flex w-full max-w-sm flex-col gap-2">
      {items.map((t) => (
        <div
          key={t.id}
          role="status"
          className={cn(
            'flex items-start gap-2 rounded-md border px-4 py-3 text-sm shadow-lg',
            variantStyles[t.variant],
          )}
        >
          <VariantIcon variant={t.variant} />
          <span className="flex-1 break-words">{t.message}</span>
          <button
            type="button"
            aria-label="Dismiss"
            className="opacity-60 transition-opacity hover:opacity-100"
            onClick={() => dismiss(t.id)}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
