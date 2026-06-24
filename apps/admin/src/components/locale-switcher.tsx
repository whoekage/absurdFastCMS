import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Languages } from 'lucide-react';
import type { Entry } from '@conti/sdk';
import { api } from '@/lib/api';
import { contentKeys, errorMessage } from '@/lib/content-manager';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogTrigger,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';

// A small per-locale dot palette (Lua). Well-known locales get a stable hue; anything else falls back
// to a deterministic pick so every variant pill carries a distinct colored dot.
const LOCALE_DOTS: Record<string, string> = {
  en: 'bg-info',
  es: 'bg-warning',
  fr: 'bg-primary',
  de: 'bg-success',
};
const FALLBACK_DOTS = ['bg-info', 'bg-warning', 'bg-primary', 'bg-success', 'bg-destructive'];

function localeDotClass(locale: string): string {
  const base = locale.toLowerCase().split('-')[0] ?? locale.toLowerCase();
  const known = LOCALE_DOTS[base];
  if (known) return known;
  let hash = 0;
  for (let i = 0; i < base.length; i += 1) hash = (hash * 31 + base.charCodeAt(i)) >>> 0;
  return FALLBACK_DOTS[hash % FALLBACK_DOTS.length] as string;
}

/**
 * i18n LOCALE SWITCHER for a single entry. Renders ONLY for an i18n type (the caller guards on
 * `def.i18n`). It lists every locale variant of THIS document (grouped by `document_id`) as quick links,
 * highlights the one being viewed, and offers a "+ locale" action that creates a NEW variant of the same
 * document (`createVariant`) and navigates to it. Shared fields are copied server-side; the new variant
 * starts with the shared values and empty localized fields (edit them on the variant's edit page).
 */
export function LocaleSwitcher({
  apiId,
  row,
}: {
  apiId: string;
  row: Entry;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [newLocale, setNewLocale] = useState('');

  const documentId = row['document_id'];
  const currentLocale = String(row['locale'] ?? '');

  // Every variant of this document (locale=* removes the locale predicate; filter by document_id).
  const variantsQuery = useQuery({
    queryKey: ['content', apiId, 'variants', documentId],
    queryFn: ({ signal }) =>
      api.list(apiId, { locale: '*', filters: { document_id: { $eq: documentId as number } } }, signal),
    enabled: documentId != null,
  });

  const variants = variantsQuery.data?.data ?? [];

  const createMutation = useMutation({
    mutationFn: (locale: string) => api.createVariant(apiId, row['id'] as number, locale, {}),
    onSuccess: async (res) => {
      await queryClient.invalidateQueries({ queryKey: contentKeys.all(apiId) });
      setOpen(false);
      setNewLocale('');
      toast.success(`Variant "${res.data.locale}" created`);
      void navigate({ to: '/content/$apiId/$id/edit', params: { apiId, id: String(res.data.id) } });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <div className="flex items-center gap-2">
      <Languages className="h-4 w-4 text-muted-foreground" />
      {/* Lua segmented locale pills — one rounded track, each variant a pill with a per-locale colored dot. */}
      <div className="flex flex-wrap items-center gap-0.5 rounded-full border bg-muted/50 p-0.5">
        {variants.map((v) => {
          const loc = String(v['locale'] ?? '');
          const active = loc === currentLocale;
          return (
            <button
              key={loc}
              type="button"
              className={cn(
                'flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors',
                active
                  ? 'bg-card text-foreground shadow-card'
                  : 'text-muted-foreground hover:text-foreground',
              )}
              aria-pressed={active}
              onClick={() =>
                active
                  ? undefined
                  : void navigate({ to: '/content/$apiId/$id', params: { apiId, id: String(v['id']) } })
              }
            >
              <span className={cn('h-1.5 w-1.5 rounded-full', localeDotClass(loc))} aria-hidden />
              {loc.toUpperCase()}
            </button>
          );
        })}

        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <button
              type="button"
              className="flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <Plus className="h-3 w-3" />
              locale
            </button>
          </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add a locale variant</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              Creates a new locale variant of this document. Shared fields are copied; edit the localized
              fields on the next screen.
            </p>
            <Input
              value={newLocale}
              placeholder="e.g. fr, pt-BR"
              onChange={(e) => setNewLocale(e.target.value)}
            />
            {variants.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Existing:{' '}
                {variants.map((v) => (
                  <Badge key={String(v['locale'])} variant="secondary" className="mr-1">
                    {String(v['locale'])}
                  </Badge>
                ))}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={newLocale.trim() === '' || createMutation.isPending}
              onClick={() => createMutation.mutate(newLocale.trim())}
            >
              {createMutation.isPending ? 'Creating…' : 'Create variant'}
            </Button>
          </DialogFooter>
        </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
